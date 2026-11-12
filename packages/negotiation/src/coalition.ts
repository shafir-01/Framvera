import type { Coalition, Currency, Id, Money, World } from '@framvera/contracts';
import type { PolicyLike } from './types.ts';
import { fmtMoney, money, unitPriceAt } from './util.ts';

export interface SidePayment {
  from: Id;
  to: Id;
  amount: Money;
}

export interface SplitAnalysis {
  method: 'shapley-exact' | 'shapley-sampled';
  payment: Money;
  shapley: Record<Id, Money>;
  outsideSource: 'private-policy' | 'published-price-estimate';
  /** Individual rationality of the plain Shapley split. */
  irBefore: boolean;
  /** Individual rationality after any side payments. */
  irAfter: boolean;
  sidePayments: SidePayment[];
  /** Set when no transfer inside the coalition payment can satisfy every outside option. */
  shortfall?: Money;
  /** Exact check of the final split against every sub-coalition (small coalitions only). */
  inCore?: boolean;
  blocking: Id[][];
  summary: string;
}

/** Split the integer total in proportion to real-valued weights, preserving the exact sum. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (w / sum) * total);
  const floor = raw.map(Math.floor);
  let left = total - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floor[i]!++;
    left--;
  }
  return floor;
}

/** Round real-valued shares to integers that sum exactly to `total`. */
function roundToTotal(total: number, xs: number[]): number[] {
  const floor = xs.map(Math.floor);
  let left = total - floor.reduce((a, b) => a + b, 0);
  const order = xs.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floor[i]!++;
    left--;
  }
  return floor;
}

function factorials(n: number): number[] {
  const f = [1];
  for (let i = 1; i <= n; i++) f.push(f[i - 1]! * i);
  return f;
}

/** Exact Shapley value over 2^n coalitions. */
export function shapleyExact(n: number, v: (mask: number) => number): number[] {
  const f = factorials(n);
  const phi = new Array<number>(n).fill(0);
  const size = (m: number) => {
    let c = 0;
    while (m) {
      m &= m - 1;
      c++;
    }
    return c;
  };
  for (let mask = 0; mask < 1 << n; mask++) {
    const s = size(mask);
    const vs = v(mask);
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      phi[i]! += (f[s]! * f[n - s - 1]! / f[n]!) * (v(mask | (1 << i)) - vs);
    }
  }
  return phi;
}

function shapleySampled(n: number, v: (mask: number) => number, samples = 2000): number[] {
  let a = 12345;
  const rnd = () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x80000000;
  };
  const phi = new Array<number>(n).fill(0);
  const perm = [...Array(n).keys()];
  for (let t = 0; t < samples; t++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
    let mask = 0;
    let prev = v(0);
    for (const i of perm) {
      mask |= 1 << i;
      const cur = v(mask);
      phi[i]! += (cur - prev) / samples;
      prev = cur;
    }
  }
  return phi;
}

/**
 * Split a coalition's payment by marginal contribution. The game: a sub-coalition that can still
 * cover every input stage with its members' claimed capacity earns the full payment; one that cannot
 * falls back to its members' outside options. Shares are the Shapley value (exact up to 12 members),
 * rounded to whole minor units that sum to the payment. Each share is checked against the member's
 * outside option; failures are repaired by transfers from members above theirs when the surplus allows,
 * otherwise the shortfall is reported. The final split is tested against every sub-coalition.
 */
export function splitCoalition(
  coalition: Coalition,
  policies?: Record<Id, PolicyLike>,
  ctx: { world?: World; payment?: Money } = {},
): Coalition & { analysis: SplitAnalysis } {
  const { world } = ctx;
  const members = [...coalition.members];
  const n = members.length;
  const currency: Currency =
    ctx.payment?.currency ?? world?.currency ?? coalition.split[0]?.share.currency ?? 'SEK';

  const offerActor = new Map<Id, Id>();
  const cost = new Map<Id, number>(members.map((m) => [m, 0]));
  const stageNeed = new Map<string, number>();
  const capByActorStage = new Map<string, number>();
  for (const inp of coalition.inputs) {
    const offer = world?.offers.find((o) => o.id === inp.offer);
    if (!offer) continue;
    offerActor.set(offer.id, offer.actor);
    cost.set(offer.actor, (cost.get(offer.actor) ?? 0) + inp.qty * unitPriceAt(offer, inp.qty) + offer.setupFee.minor);
    stageNeed.set(offer.stage, (stageNeed.get(offer.stage) ?? 0) + inp.qty);
    const k = `${offer.actor}|${offer.stage}`;
    capByActorStage.set(k, (capByActorStage.get(k) ?? 0) + offer.capacity);
  }
  const mapped = offerActor.size > 0;

  const totalCost = [...cost.values()].reduce((a, b) => a + b, 0);
  const paymentMinor =
    ctx.payment?.minor ?? (mapped ? totalCost : coalition.split.reduce((a, s) => a + s.share.minor, 0));
  const fromPolicy = !!policies && members.every((m) => policies[m]?.outside);
  const outside = members.map((m) => (fromPolicy ? policies![m]!.outside.minor : mapped ? cost.get(m) ?? 0 : 0));

  const delivers = (mask: number): boolean => {
    if (!mapped) return mask === (1 << n) - 1;
    for (const [stage, need] of stageNeed) {
      let cap = 0;
      members.forEach((m, i) => {
        if (mask & (1 << i)) cap += capByActorStage.get(`${m}|${stage}`) ?? 0;
      });
      if (cap < need) return false;
    }
    return true;
  };
  const vCache = new Map<number, number>();
  const v = (mask: number): number => {
    const hit = vCache.get(mask);
    if (hit !== undefined) return hit;
    let val = 0;
    if (mask !== 0) {
      if (delivers(mask)) val = paymentMinor;
      else members.forEach((_, i) => mask & (1 << i) && (val += outside[i]!));
    }
    vCache.set(mask, val);
    return val;
  };

  const exact = n <= 12;
  const phiReal = exact ? shapleyExact(n, v) : shapleySampled(n, v);
  const phi = roundToTotal(paymentMinor, phiReal);
  const shares = [...phi];

  const irBefore = shares.every((x, i) => x >= outside[i]!);
  const sidePayments: SidePayment[] = [];
  let shortfall: Money | undefined;
  if (!irBefore) {
    const deficits = shares.map((x, i) => Math.max(0, outside[i]! - x));
    const excess = shares.map((x, i) => Math.max(0, x - outside[i]!));
    const D = deficits.reduce((a, b) => a + b, 0);
    const E = excess.reduce((a, b) => a + b, 0);
    if (E >= D) {
      const take = apportion(D, excess);
      const give = deficits.map((d) => d);
      take.forEach((t, j) => (shares[j]! -= t));
      give.forEach((g, i) => (shares[i]! += g));
      const donors = take.map((t, j) => ({ j, left: t })).filter((d) => d.left > 0);
      for (let i = 0; i < n; i++) {
        let need = give[i]!;
        for (const d of donors) {
          if (need <= 0) break;
          const amt = Math.min(need, d.left);
          if (amt <= 0) continue;
          sidePayments.push({ from: members[d.j]!, to: members[i]!, amount: money(currency, amt) });
          d.left -= amt;
          need -= amt;
        }
      }
    } else {
      shortfall = money(currency, D - E);
    }
  }
  const irAfter = shares.every((x, i) => x >= outside[i]!);

  const blocking: Id[][] = [];
  let inCore: boolean | undefined;
  if (exact) {
    inCore = true;
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      let sum = 0;
      members.forEach((_, i) => mask & (1 << i) && (sum += shares[i]!));
      if (sum < v(mask)) {
        inCore = false;
        if (blocking.length < 5) blocking.push(members.filter((_, i) => mask & (1 << i)));
      }
    }
  }

  const fmt = (x: number) => fmtMoney(money(currency, x));
  const split = members.map((m, i) => {
    const received = sidePayments.filter((s) => s.to === m).reduce((a, s) => a + s.amount.minor, 0);
    const paid = sidePayments.filter((s) => s.from === m).reduce((a, s) => a + s.amount.minor, 0);
    let reason = `Shapley value of its marginal contribution: ${fmt(phi[i]!)}.`;
    if (received) reason += ` Plus ${fmt(received)} from coalition surplus to meet its outside option of ${fmt(outside[i]!)}.`;
    if (paid) reason += ` Less ${fmt(paid)} transferred to keep every member above its outside option.`;
    if (!irAfter && shares[i]! < outside[i]!) reason += ` Below its outside option of ${fmt(outside[i]!)}.`;
    return { actor: m, share: money(currency, shares[i]!), reason };
  });
  const rationality = members.map((m, i) => ({ actor: m, outside: money(currency, outside[i]!), ok: shares[i]! >= outside[i]! }));

  const summary = irAfter
    ? sidePayments.length
      ? `The plain split leaves ${sidePayments.map((s) => s.to).filter((x, i, a) => a.indexOf(x) === i).join(', ')} below the outside option; ${fmt(sidePayments.reduce((a, s) => a + s.amount.minor, 0))} moves from coalition surplus so every member does at least as well as its alternative.`
      : 'Every member receives at least its outside option under the Shapley split.'
    : `No split of ${fmt(paymentMinor)} meets every outside option: the coalition is ${fmt(shortfall?.minor ?? 0)} short.`;

  return {
    ...coalition,
    split,
    rationality,
    analysis: {
      method: exact ? 'shapley-exact' : 'shapley-sampled',
      payment: money(currency, paymentMinor),
      shapley: Object.fromEntries(members.map((m, i) => [m, money(currency, phi[i]!)])),
      outsideSource: fromPolicy ? 'private-policy' : 'published-price-estimate',
      irBefore,
      irAfter,
      sidePayments,
      ...(shortfall ? { shortfall } : {}),
      ...(inCore !== undefined ? { inCore } : {}),
      blocking,
      summary,
    },
  };
}
