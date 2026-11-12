const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export interface CopilotLine {
  label: string;
  now: string;
  after: string;
}

export interface Proposal {
  id: string;
  termsHash: string;
  type: string;
  from: string;
  expires: string | null;
  fieldLabel: string;
  change: { from: string; to: string };
  benefit: string;
  copilot: { lines: CopilotLine[]; notes: string[] };
  input: { kind: 'money' | 'int' | 'time'; current: number | null };
}

export interface SellerOffer {
  id: string;
  stage: string;
  unit: string;
  capacity: number;
  minQty: number;
  ratePerHour: number;
  setupFee: string;
  price: string;
  windowStart: string;
  windowEnd: string;
  withdrawn: boolean;
}

export interface SellerView {
  world: string;
  actor: { id: string; name: string; city: string };
  offers: SellerOffer[];
  commitments: { id: string; qty: number; due: string; amount: string; state: string }[];
  canWithdraw: boolean;
  pending: Proposal[];
  answered: { id: string; action: 'accept' | 'reject' | 'counter'; at: string }[];
}

export class SellerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api/markets/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!r.ok) throw new SellerError(r.status, data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong');
  return data as T;
}

const base = (market: string, actor: string) => `${encodeURIComponent(market)}/seller/${encodeURIComponent(actor)}`;

export const seller = {
  redeem: (market: string, actor: string, token: string) => call<{ session: string }>(`${base(market, actor)}/seat`, { token }),
  view: (market: string, actor: string, session: string) => call<SellerView>(`${base(market, actor)}/view`, { session }),
  answer: (market: string, actor: string, session: string, data: { termsHash: string; action: 'accept' | 'reject' | 'counter'; counter?: { to: number | string }; reason?: string }) =>
    call<{ decision: unknown }>(`${base(market, actor)}/answer`, { session, ...data }),
  withdraw: (market: string, actor: string, session: string, offer: string, reason?: string) => call<unknown>(`${base(market, actor)}/withdraw`, { session, offer, reason }),
  leave: (market: string, actor: string, session: string) => call<unknown>(`${base(market, actor)}/leave`, { session }),
};

export function parseSellerHash(hash: string): { market: string; actor: string; seat?: string } | null {
  const m = /^#\/seller\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const seat = new URLSearchParams(m[3] ?? '').get('seat') ?? undefined;
  return { market: decodeURIComponent(m[1]!), actor: decodeURIComponent(m[2]!), seat };
}

export const storageKey = (market: string, actor: string) => `framvera.seat.${market}.${actor}`;
