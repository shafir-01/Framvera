import type { Allocation, Intent, Plan, Verification, World } from '@framvera/contracts';
import { effectiveCapacity, jointMembers, offerCost } from '@framvera/contracts';
import { fmtMoney } from './text.ts';

/** Rounding allowance for times, in milliseconds. */
export const TIME_TOLERANCE_MS = 1000;
const HOUR = 3_600_000;

export interface VerifyOptions {
  /** Kept commitments: their agreed cost and times are accepted as recorded. */
  fixed?: Allocation[];
  /** 'effective' (default): claimed capacity minus capacity recorded as already booked. 'claimed': face value. */
  capacity?: 'effective' | 'claimed';
}

const t = (s: string) => Date.parse(s);

/** Independent re-check of a plan using plain arithmetic over the world's published terms. */
export function verifyPlan(plan: Plan, world: World, intent: Intent, opts: VerifyOptions = {}): Verification {
  const checks: Verification['checks'] = [];
  const add = (id: string, problems: string[], okText: string) =>
    checks.push({ id, ok: problems.length === 0, text: problems.length ? problems.slice(0, 3).join(' ') : okText });

  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const actors = new Map(world.actors.map((a) => [a.id, a]));
  const stages = new Map(world.stages.map((s) => [s.id, s]));
  const fixed = new Map((opts.fixed ?? []).map((f) => [f.offer, f]));
  const isFixed = (a: Allocation) => {
    const f = fixed.get(a.offer);
    return !!f && f.qty === a.qty && f.start === a.start && f.finish === a.finish && f.cost.minor === a.cost.minor;
  };
  const currency = intent.budget.currency;
  const now = t(world.createdAt);
  const allocs = plan.allocations;
  const nameOf = (actor: string) => actors.get(actor)?.name ?? actor;

  add(
    'identity',
    [
      ...(plan.worldVersion !== world.version ? [`Plan was made for world version ${plan.worldVersion}, not ${world.version}.`] : []),
      ...(plan.intent !== intent.id ? [`Plan belongs to request ${plan.intent}, not ${intent.id}.`] : []),
    ],
    'Plan matches this world version and request.',
  );

  const refProblems: string[] = [];
  for (const a of allocs) {
    const o = offers.get(a.offer);
    if (!o) refProblems.push(`Offer ${a.offer} does not exist.`);
    else if (o.actor !== a.actor || o.stage !== a.stage) refProblems.push(`Allocation on ${a.offer} names the wrong supplier or stage.`);
    else if (!actors.get(o.actor)?.active) refProblems.push(`${nameOf(o.actor)} is not active.`);
    else if (o.id.startsWith('joint:')) {
      const members = (jointMembers(o.id) ?? []).map((id) => offers.get(id));
      if (members.some((mo) => mo && !actors.get(mo.actor)?.active)) refProblems.push(`A member of the joint offer ${o.id} has left.`);
    }
    else if (!stages.has(o.stage)) refProblems.push(`Stage ${o.stage} does not exist.`);
    if (!Number.isInteger(a.qty) || a.qty <= 0) refProblems.push(`Allocation on ${a.offer} has quantity ${a.qty}.`);
    if (Number.isNaN(t(a.start)) || Number.isNaN(t(a.finish))) refProblems.push(`Allocation on ${a.offer} has an invalid time.`);
  }
  add('offers', refProblems, 'Every allocation uses an existing, active offer.');
  if (refProblems.length) return { ok: false, checks };

  const seen = new Map<string, number>();
  for (const a of allocs) seen.set(a.offer, (seen.get(a.offer) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => `Offer ${id} is allocated ${seen.get(id)} times.`);
  for (const a of allocs) {
    for (const member of jointMembers(a.offer) ?? []) {
      if (seen.has(member)) dup.push(`${nameOf(offers.get(member)!.actor)} is booked both alone and in a joint offer.`);
    }
  }
  add('exclusive', dup, 'No capacity is promised twice.');

  const validity = allocs
    .filter((a) => !isFixed(a) && t(offers.get(a.offer)!.validUntil) < now)
    .map((a) => `The offer from ${nameOf(a.actor)} has expired.`);
  add('validity', validity, 'Every offer is still valid.');


  const demandProblems: string[] = [];
  for (const s of world.stages) {
    const need = Math.ceil(intent.quantity * s.perOutcome - 1e-9);
    const got = allocs.filter((a) => a.stage === s.id).reduce((acc, a) => acc + a.qty, 0);
    if (got < need) demandProblems.push(`${s.name} produces ${got} of ${need} ${s.unit}.`);
  }
  add('demand', demandProblems, 'Every stage produces enough.');

  const capProblems: string[] = [];
  for (const [offer, total] of sumBy(allocs)) {
    const o = offers.get(offer)!;
    const room = opts.capacity === 'claimed' ? o.capacity : effectiveCapacity(world, o);
    if (total > room) capProblems.push(`${nameOf(o.actor)} is asked for ${total} but has room for ${room}.`);
  }
  add('capacity', capProblems, 'No supplier is asked for more than its capacity.');

  const moqProblems: string[] = [];
  for (const a of allocs) {
    const o = offers.get(a.offer)!;
    if (a.qty >= o.minQty || isFixed(a)) continue;
    moqProblems.push(`${nameOf(o.actor)} gets ${a.qty}, below its minimum of ${o.minQty}.`);
  }
  add('min-qty', moqProblems, 'Every order meets its supplier’s minimum.');

  const winProblems: string[] = [];
  const durProblems: string[] = [];
  for (const a of allocs) {
    const o = offers.get(a.offer)!;
    const start = t(a.start);
    const workEnd = t(a.finish) - o.handoffHours * HOUR;
    if (start < t(o.window.start) - TIME_TOLERANCE_MS || workEnd > t(o.window.end) + TIME_TOLERANCE_MS) {
      winProblems.push(`${nameOf(o.actor)} works outside its window.`);
    }
    if (workEnd - start < (a.qty / o.ratePerHour) * HOUR - TIME_TOLERANCE_MS) {
      durProblems.push(`${nameOf(o.actor)} needs ${(a.qty / o.ratePerHour).toFixed(1)} hours but is given ${((workEnd - start) / HOUR).toFixed(1)}.`);
    }
  }
  add('window', winProblems, 'All work happens inside each supplier’s window.');
  add('duration', durProblems, 'Every supplier has enough hours for its quantity.');

  const precProblems: string[] = [];
  for (const a of allocs) {
    const st = stages.get(a.stage)!;
    for (const p of st.after) {
      for (const b of allocs) {
        if (b.stage !== p) continue;
        if (t(b.finish) > t(a.start) + TIME_TOLERANCE_MS) {
          precProblems.push(`${nameOf(a.actor)} starts before ${nameOf(b.actor)}'s output arrives.`);
        }
      }
    }
  }
  add('precedence', precProblems, 'Each stage starts after the stages it depends on.');

  const preds = new Set(world.stages.flatMap((s) => s.after));
  const finals = allocs.filter((a) => !preds.has(a.stage));
  const readyMs = finals.length ? Math.max(...finals.map((a) => t(a.finish))) : NaN;
  const dl = t(intent.deadline);
  const deadlineProblems: string[] = [];
  if (Number.isFinite(readyMs) && readyMs > dl + TIME_TOLERANCE_MS) deadlineProblems.push('The final output arrives after the deadline.');
  if (Number.isFinite(readyMs) && Math.abs(readyMs - t(plan.readyAt)) > TIME_TOLERANCE_MS) deadlineProblems.push('The stated ready time does not match the schedule.');
  if (t(plan.readyAt) > dl + TIME_TOLERANCE_MS) deadlineProblems.push('The stated ready time is after the deadline.');
  add('deadline', deadlineProblems, 'Everything is ready by the deadline.');

  const moneyProblems: string[] = [];
  let sum = 0;
  for (const a of allocs) {
    const o = offers.get(a.offer)!;
    if (a.cost.currency !== currency) moneyProblems.push(`Allocation on ${a.offer} is priced in ${a.cost.currency}.`);
    if (!Number.isSafeInteger(a.cost.minor)) moneyProblems.push(`Allocation on ${a.offer} has a non-integer amount.`);
    if (!isFixed(a)) {
      const expected = offerCost(o, a.qty).minor;
      if (expected !== a.cost.minor) moneyProblems.push(`${nameOf(o.actor)} costs ${fmtMoney({ currency, minor: expected })} by its published terms, not ${fmtMoney({ currency, minor: a.cost.minor })}.`);
    }
    sum += a.cost.minor;
  }
  if (plan.total.currency !== currency) moneyProblems.push(`Plan total is in ${plan.total.currency}.`);
  if (!Number.isSafeInteger(plan.total.minor) || plan.total.minor !== sum) moneyProblems.push(`Plan total ${plan.total.minor} does not equal the sum of its parts, ${sum}.`);
  add('money', moneyProblems, 'Every amount matches published prices and the total adds up exactly.');

  const budgetProblems: string[] = [];
  if (sum > intent.budget.minor) budgetProblems.push(`Total ${fmtMoney({ currency, minor: sum })} exceeds the budget of ${fmtMoney(intent.budget)}.`);
  const auth = intent.authority.maxSpend;
  if (auth.currency === currency && sum > auth.minor) budgetProblems.push(`Total ${fmtMoney({ currency, minor: sum })} exceeds the spending authority of ${fmtMoney(auth)}.`);
  add('budget', budgetProblems, 'Total spend is within budget and spending authority.');

  return { ok: checks.every((c) => c.ok), checks };
}

function sumBy(allocs: Allocation[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of allocs) m.set(a.offer, (m.get(a.offer) ?? 0) + a.qty);
  return m;
}
