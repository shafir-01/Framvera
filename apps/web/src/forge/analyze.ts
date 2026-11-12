import type { Allocation, Coalition, Id, Intent, Money, Plan, SolveReport, StageId, Verification, World } from '@framvera/contracts';
import { coalitionFromPlan, draft, restrict, stageAllocations, type Draft } from './model.ts';

export interface SplitView {
  method: 'shapley-exact' | 'shapley-sampled';
  payment: Money;
  shapley: Record<Id, Money>;
  outsideSource: 'private-policy' | 'published-price-estimate';
  irBefore: boolean;
  irAfter: boolean;
  sidePayments: { from: Id; to: Id; amount: Money }[];
  shortfall?: Money;
  inCore?: boolean;
  blocking: Id[][];
  summary: string;
}

export type SplitResult = Coalition & { analysis: SplitView };

/** Everything the Forge needs from the rest of the app. Injected so it can be exercised without a browser. */
export interface ForgeEngine {
  solve(world: World, intent: Intent, opts?: { coalitions?: Coalition[]; timeLimitMs?: number }): Promise<SolveReport>;
  verify?(plan: Plan, world: World, intent: Intent): Verification;
  split(
    coalition: Coalition,
    policies: Record<Id, { reservation: Record<string, never>; riskTolerance: number; outside: Money }> | undefined,
    ctx: { world?: World; payment?: Money },
  ): SplitResult;
}

export interface Analysis {
  draft: Draft;
  /** Plan for the whole intent when this bundle is the only supply for the stage. */
  report?: SolveReport;
  verification?: Verification;
  /** Best plan with every offer open, for comparison. */
  open?: SolveReport;
  /** Members the plan actually buys from. */
  used: Id[];
  split?: SplitResult;
  /** Members the plan has no use for. */
  idle: Id[];
}

export const MAX_SHAPLEY_EXACT = 6;

export function sumAlloc(allocs: Allocation[], currency: Money['currency']): Money {
  return { currency, minor: allocs.reduce((a, x) => a + x.cost.minor, 0) };
}

export async function analyze(
  engine: ForgeEngine,
  world: World,
  intent: Intent,
  stage: StageId,
  members: Id[],
  opts: { outside?: Record<Id, Money>; open?: Promise<SolveReport> } = {},
): Promise<Analysis | undefined> {
  const d = draft(world, intent, stage, members);
  if (!d) return undefined;
  const base: Analysis = { draft: d, used: [], idle: [] };
  if (!d.coalition || !d.covers) return base;
  const restricted = restrict(world, d);
  const [report, open] = await Promise.all([
    engine.solve(restricted, intent, d.coalition.members.length > 1 ? { coalitions: [d.coalition] } : {}),
    opts.open ?? engine.solve(world, intent).catch(() => undefined),
  ]);
  const out: Analysis = { ...base, report, ...(open ? { open } : {}) };
  const plan = report.plan;
  if (!plan) return out;
  if (engine.verify) out.verification = engine.verify(plan, restricted, intent);
  const allocs = stageAllocations(plan, stage);
  const bought = coalitionFromPlan(d.coalition, allocs);
  out.used = bought.members;
  out.idle = d.lanes.map((l) => l.actor).filter((a) => !bought.members.includes(a));
  if (bought.members.length === 0 || bought.members.length > MAX_SHAPLEY_EXACT) return out;
  const payment = sumAlloc(allocs, world.currency);
  const policies =
    opts.outside && bought.members.every((m) => opts.outside![m])
      ? Object.fromEntries(bought.members.map((m) => [m, { reservation: {}, riskTolerance: 0.5, outside: opts.outside![m]! }]))
      : undefined;
  out.split = engine.split(bought, policies, { world: restricted, payment });
  return out;
}

export type Verdict = 'agrees' | 'declines' | 'idle';

export interface MemberView {
  actor: Id;
  verdict: Verdict;
  share?: Money;
  outside?: Money;
  /** Transfer from coalition surplus that lifts the member to its alternative, when one is needed. */
  topUp?: Money;
  line: string;
}

/** One plain line per member on why it would or would not take part. Never a statement that it has agreed. */
export function memberViews(a: Analysis, fmt: (m: Money) => string, name: (id: Id) => string): MemberView[] {
  const out: MemberView[] = [];
  for (const id of a.idle) {
    out.push({ actor: id, verdict: 'idle', line: `${name(id)} has nothing to supply: the others already cover this stage.` });
  }
  const s = a.split;
  if (!s) return out;
  for (const m of s.members) {
    const row = s.split.find((x) => x.actor === m);
    const rat = s.rationality.find((x) => x.actor === m);
    if (!row || !rat) continue;
    const plain = s.analysis.shapley[m] ?? row.share;
    const topUp = row.share.minor > plain.minor ? { currency: row.share.currency, minor: row.share.minor - plain.minor } : undefined;
    if (rat.ok) {
      const line = topUp
        ? `Its marginal share is ${fmt(plain)}, under its estimated alternative of ${fmt(rat.outside)}; ${fmt(topUp)} from the others lifts it to ${fmt(row.share)}.`
        : `It receives ${fmt(row.share)}, at or above its estimated alternative of ${fmt(rat.outside)}, so it has reason to say yes.`;
      out.push({ actor: m, verdict: 'agrees', share: row.share, outside: rat.outside, ...(topUp ? { topUp } : {}), line });
    } else {
      out.push({
        actor: m,
        verdict: 'declines',
        share: row.share,
        outside: rat.outside,
        line: `It would receive ${fmt(row.share)}, below its estimated alternative of ${fmt(rat.outside)}, so it would likely decline.`,
      });
    }
  }
  return out;
}
