/**
 * Hosted proxy (Cloudflare Pages Function, free plan): POST /api/jev → TypeSafe System One.
 * Bring-your-own-key: the visitor's key arrives in the X-Jev-Key header, is used for this one
 * request and is never stored or logged. Only same-origin requests are accepted.
 */
import { MAX_BODY_BYTES, handleJev, plausibleKey } from '../../../server/jevShared';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request }: { request: Request }): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json(403, { error: 'cross-origin requests are not accepted' });
  const key = request.headers.get('X-Jev-Key');
  if (!plausibleKey(key)) return json(401, { error: 'Enter your own Jev (TypeSafe) API key to use live Jev features' });
  const len = Number(request.headers.get('Content-Length') ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: 'body too large' });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: 'body too large' });
  try {
    const out = await handleJev(key, 'jev-latest', text);
    return json(out.status, out.json);
  } catch {
    return json(502, { error: 'upstream error' });
  }
}

export function onRequest(): Response {
  return json(405, { error: 'POST only' });
}
