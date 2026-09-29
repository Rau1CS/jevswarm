/** Hosted status: no server key exists here; visitors bring their own (see index.ts). */
export function onRequestGet(): Response {
  return new Response(JSON.stringify({ configured: false, byok: true, model: 'jev-latest' }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
