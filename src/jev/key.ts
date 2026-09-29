/**
 * Bring-your-own Jev key (hosted build). Kept in this browser only: sessionStorage by default,
 * localStorage when the visitor ticks "remember". Sent per request to this site's proxy, which
 * forwards it to api.typesafe.ai and never stores it.
 */
const K = 'jev.key.v1';

function stores(): Storage[] {
  const out: Storage[] = [];
  try { out.push(sessionStorage); } catch { /* unavailable */ }
  try { out.push(localStorage); } catch { /* unavailable */ }
  return out;
}

export function getJevKey(): string | null {
  for (const s of stores()) {
    try {
      const v = s.getItem(K);
      if (v) return v;
    } catch { /* ignore */ }
  }
  return null;
}

export function setJevKey(key: string, remember: boolean): void {
  clearJevKey();
  try { (remember ? localStorage : sessionStorage).setItem(K, key.trim()); } catch { /* storage blocked: key lives only in memory */ memoryKey = key.trim(); }
}

export function clearJevKey(): void {
  memoryKey = null;
  for (const s of stores()) {
    try { s.removeItem(K); } catch { /* ignore */ }
  }
}

let memoryKey: string | null = null;
export const currentJevKey = (): string | null => getJevKey() ?? memoryKey;

export interface JevStatus { configured: boolean; byok: boolean; model: string }

/** Is Jev usable right now: a server key (local dev) or a visitor key (hosted/BYOK). */
export async function jevStatus(): Promise<JevStatus & { usable: boolean }> {
  try {
    const j = (await (await fetch('/api/jev/status')).json()) as JevStatus;
    return { ...j, usable: j.configured || (j.byok && Boolean(currentJevKey())) };
  } catch {
    return { configured: false, byok: false, model: 'jev-latest', usable: false };
  }
}
