/**
 * Shared by the local Vite proxy (server/jevProxy.ts) and the hosted Cloudflare Pages Function
 * (functions/api/jev/index.ts): payload validation and forwarding to TypeSafe System One.
 * Contract: https://docs.typesafe.ai/api.md — the API key is never logged or stored.
 */
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_QUESTIONS = 64;
const RETRY_STATUSES = new Set([429, 529]);

/** Validate the client payload at the boundary; only state + questions are forwarded. */
export function validate(raw: unknown): { state: unknown; questions: Record<string, unknown> } | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be an object';
  const { state, questions } = raw as Record<string, unknown>;
  if (state === undefined) return 'missing state';
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) return 'questions must be a map';
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) return `questions must have 1..${MAX_QUESTIONS} entries`;
  for (const [id, q] of entries) {
    const t = (q as { type?: unknown })?.type;
    if (t !== 'noul' && t !== 'choice' && t !== 'score') return `question ${id}: invalid type`;
  }
  return { state, questions: questions as Record<string, unknown> };
}

/** A visitor-supplied key: printable, no whitespace, sane length. */
export function plausibleKey(k: string | null | undefined): k is string {
  return typeof k === 'string' && /^[\x21-\x7e]{8,512}$/.test(k);
}

export async function forward(apiKey: string, body: string): Promise<{ status: number; json: unknown }> {
  let delay = 400;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (RETRY_STATUSES.has(r.status) && attempt < 2) {
      const retryAfter = Number(r.headers.get('retry-after'));
      await new Promise((ok) => setTimeout(ok, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay));
      delay *= 2;
      continue;
    }
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 500) };
    }
    return { status: r.status, json };
  }
  return { status: 529, json: { error: 'overloaded after retries' } };
}

/** Handle one proxied request (runtime-agnostic): parse, validate, forward. */
export async function handleJev(apiKey: string, model: string, text: string): Promise<{ status: number; json: unknown }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, json: { error: 'invalid JSON' } };
  }
  const v = validate(parsed);
  if (typeof v === 'string') return { status: 422, json: { error: v } };
  return forward(apiKey, JSON.stringify({ state: v.state, model, questions: v.questions }));
}
