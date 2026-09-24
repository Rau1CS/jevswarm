/**
 * Server-side proxy for the TypeSafe System One API (Jev).
 *
 * The browser never sees the API key: it POSTs { state, questions } to /api/jev and this
 * middleware forwards the request to https://api.typesafe.ai/v1/systemone with the key.
 * Contract per https://docs.typesafe.ai/api.md
 */
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUESTIONS = 64;
const RETRY_STATUSES = new Set([429, 529]);

interface ProxyOptions {
  apiKey?: string;
  model?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Validate the client payload at the boundary; only state + questions are forwarded. */
function validate(raw: unknown): { state: unknown; questions: Record<string, unknown> } | string {
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

async function forward(apiKey: string, body: string): Promise<{ status: number; json: unknown }> {
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

function middleware(opts: ProxyOptions): Connect.NextHandleFunction {
  const apiKey = opts.apiKey?.trim();
  const model = opts.model?.trim() || 'jev-latest';
  return (req, res, next) => {
    const url = req.url ?? '';
    if (url === '/api/jev/status') {
      send(res, 200, { configured: Boolean(apiKey), model });
      return;
    }
    if (url !== '/api/jev') return next();
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!apiKey) return send(res, 503, { error: 'TYPESAFE_API_KEY not configured' });
    readBody(req)
      .then(async (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        const v = validate(parsed);
        if (typeof v === 'string') return send(res, 422, { error: v });
        const out = await forward(apiKey, JSON.stringify({ state: v.state, model, questions: v.questions }));
        send(res, out.status, out.json);
      })
      .catch((e: unknown) => send(res, 502, { error: e instanceof Error ? e.message : 'proxy error' }));
  };
}

export function jevProxyPlugin(opts: ProxyOptions): Plugin {
  return {
    name: 'jev-proxy',
    configureServer(server) {
      server.middlewares.use(middleware(opts));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(opts));
    },
  };
}
