/**
 * Real disaster-message feeds, loaded at runtime from their public sources (nothing is bundled,
 * so the tweet text is never redistributed with this app):
 *   HumAID (QCRI, CC BY-NC-SA 4.0) via the Hugging Face datasets-server rows API
 *   CrisisLexT26 (Olteanu et al.) via raw GitHub CSVs
 * Each message keeps its human labels so the console can show agreement honestly.
 */

export interface FeedMessage {
  id: string;
  text: string;
  /** Human labels from the dataset (shown next to Jev's answers). */
  human: { category?: string; source?: string; infoType?: string };
}

export interface FeedSource {
  id: string;
  name: string;
  dataset: string;
  url: string;
  load(): Promise<FeedMessage[]>;
}

const HF_ROWS = 'https://datasets-server.huggingface.co/rows';

async function humaid(config: string, split: string, total: number): Promise<FeedMessage[]> {
  const pages = Math.ceil(total / 100);
  const out: FeedMessage[] = [];
  const reqs = Array.from({ length: pages }, (_, p) =>
    fetch(`${HF_ROWS}?dataset=QCRI%2FHumAID-events&config=${config}&split=${split}&offset=${p * 100}&length=100`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .catch(() => ({ rows: [] })));
  for (const page of await Promise.all(reqs)) {
    for (const { row_idx, row } of (page as { rows: { row_idx: number; row: { tweet_text: string; class_label: string } }[] }).rows) {
      out.push({ id: `h${row_idx}`, text: row.tweet_text, human: { category: row.class_label } });
    }
  }
  return out;
}

/** Minimal RFC-4180 CSV parser (quoted fields, doubled quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function crisislex(event: string): Promise<FeedMessage[]> {
  const url = `https://raw.githubusercontent.com/sajao/CrisisLex/master/data/CrisisLexT26/${event}/${event}-tweets_labeled.csv`;
  const rows = parseCsv(await (await fetch(url)).text());
  const head = rows[0].map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const [ti, si, ii] = [col('Tweet Text'), col('Information Source'), col('Information Type')];
  return rows.slice(1).filter((r) => r.length > ti && r[ti]).map((r, k) => ({
    id: `${event}-${k}`,
    text: r[ti],
    // "Not labeled" / "Not applicable" rows carry no human judgment: keep the message, drop the label.
    human: /^not /i.test(r[si]?.trim() ?? '') ? {} : { source: r[si]?.trim(), infoType: r[ii]?.trim() },
  }));
}

export const FEEDS: FeedSource[] = [
  {
    id: 'CA2018', name: 'California wildfires · Nov 2018', dataset: 'HumAID (QCRI)',
    url: 'https://huggingface.co/datasets/QCRI/HumAID-events',
    load: () => humaid('california_wildfires_2018', 'test', 1461),
  },
  {
    id: 'CO2012', name: 'Colorado wildfires · Jun 2012', dataset: 'CrisisLexT26',
    url: 'https://github.com/sajao/CrisisLex',
    load: () => crisislex('2012_Colorado_wildfires'),
  },
  {
    id: 'AU2013', name: 'Australia bushfire · Oct 2013', dataset: 'CrisisLexT26',
    url: 'https://github.com/sajao/CrisisLex',
    load: () => crisislex('2013_Australia_bushfire'),
  },
];

/** Deterministic shuffle so a replayed stream isn't ordered by dataset row. */
export function shuffled<T>(xs: T[], seed = 42): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
