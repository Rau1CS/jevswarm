/**
 * Local (Vite dev/preview) proxy for the TypeSafe System One API (Jev).
 *
 * The browser POSTs { state, questions } to /api/jev and this middleware forwards it to
 * https://api.typesafe.ai/v1/systemone. Key: TYPESAFE_API_KEY from .env.local (never sent to
 * the browser); if none is configured, a visitor-supplied key in the X-Jev-Key header is used
 * for that request only (bring-your-own-key, same as the hosted Pages Function).
 */
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, handleJev, plausibleKey } from './jevShared';

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

function middleware(opts: ProxyOptions): Connect.NextHandleFunction {
  const serverKey = opts.apiKey?.trim();
  const model = opts.model?.trim() || 'jev-latest';
  return (req, res, next) => {
    const url = req.url ?? '';
    if (url === '/api/jev/status') {
      send(res, 200, { configured: Boolean(serverKey), byok: !serverKey, model });
      return;
    }
    if (url !== '/api/jev') return next();
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const header = req.headers['x-jev-key'];
    const visitorKey = Array.isArray(header) ? header[0] : header;
    const apiKey = serverKey || (plausibleKey(visitorKey) ? visitorKey : undefined);
    if (!apiKey) return send(res, 401, { error: 'No Jev key: set TYPESAFE_API_KEY in .env.local or enter your own key' });
    readBody(req)
      .then(async (text) => {
        const out = await handleJev(apiKey, model, text);
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
