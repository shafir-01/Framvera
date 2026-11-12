import type { Coalition, Concession, Intent, Iso, NegotiationMessage, SolveReport, SupplierDecision, World } from '@framvera/contracts';
import { createSupplierDesk, isCharge, namesCoalition } from './policy.ts';
import type { MessageText, NegotiationRun, QuestionMessage, RankedQuestion, SolverApi, TruthLike } from './types.ts';
import { Clock, HOUR, actorName, concessionKey, sha256, termsOf } from './util.ts';
import { changePhrase, selectQuestions, simulateOutcomes } from './voi.ts';

export interface NegotiateOptions {
  /** Maximum number of questions sent to suppliers. */
  budget?: number;
  k?: number;
  maxChanges?: number;
  maxSolves?: number;
  now?: Iso;
  solver?: SolverApi;
  /** The buyer's explicit answer to a deadline or budget change. Undefined means not yet asked. */
  buyerConsent?: (c: Concession) => boolean | undefined;
  /** Human supplier answers for selected messages, from the seller terminal. */
  terminal?: Parameters<typeof createSupplierDesk>[2];
}

export async function loadSolver(): Promise<SolverApi> {
  const mod = (await import('@framvera/solver')) as Partial<SolverApi>;
  for (const fn of ['solve', 'findInterventions', 'applyConcessions', 'verifyPlan'] as const) {
    if (typeof mod[fn] !== 'function') throw new Error(`@framvera/solver does not export ${fn}`);
  }
  return mod as SolverApi;
}

/** A change that only makes the buyer pay more: a higher setup fee or unit price. */
function isSupplierCharge(c: Concession): boolean {
  return c.target.kind === 'offer' && (c.target.field === 'setupFee' || c.target.field === 'unitPrice') && Number(c.to) > Number(c.from);
}

/**
 * Applies concessions through the solver. Charges a supplier added in a counter can target fields the
 * offer does not list as negotiable; when the solver declines those, they are applied to its output copy.
 */
export function applyAll(solver: SolverApi, world: World, intent: Intent, cs: Concession[]): { world: World; intent: Intent } {
  try {
    return solver.applyConcessions(world, intent, cs);
  } catch (e) {
    const charges = cs.filter(isSupplierCharge);
    if (!charges.length) throw e;
    const next = solver.applyConcessions(world, intent, cs.filter((c) => !isSupplierCharge(c)));
    const out = cs.length === charges.length ? { world: { ...structuredClone(world), version: world.version + 1 }, intent: structuredClone(intent) } : next;
    for (const c of charges) {
      const o = out.world.offers.find((x) => c.target.kind === 'offer' && x.id === c.target.offer);
      if (!o) throw e;
      const delta = Math.round(Number(c.to) - Number(c.from));
      if (c.target.kind === 'offer' && c.target.field === 'setupFee') o.setupFee = { ...o.setupFee, minor: o.setupFee.minor + delta };
      else o.tiers = o.tiers.map((t) => ({ ...t, unit: { ...t.unit, minor: t.unit.minor + delta } }));
      o.version += 1;
      o.derivedFrom = { ...(o.derivedFrom ?? {}), concessions: [...(o.derivedFrom?.concessions ?? []), c.id] };
    }
    return out;
  }
}

function feasible(status: string): boolean {
  return status === 'optimal' || status === 'feasible';
}

function messageText(msg: NegotiationMessage, world: World, benefits: Map<string, string>, all: NegotiationMessage[]): string {
  const name = (id: string) => actorName(world, id);
  const recipient = (id: string) => {
    const m = all.find((x) => x.id === id);
    return m && 'to' in m ? name(m.to) : id;
  };
  switch (msg.type) {
    case 'Propose': {
      const benefit = benefits.get(msg.id);
      const cond = !benefit && msg.conditional?.length ? ` Binds only if ${msg.conditional.map(recipient).join(' and ')} also agree.` : '';
      return `Proposal to ${name(msg.to)}: ${benefit ?? `${changePhrase(msg.concession, world)}.`}${cond}`;
    }
    case 'AskPreference':
      return `Question for ${name(msg.to)}: ${msg.benefit}`;
    case 'CounterOffer':
      return `${name(msg.from)} counters: ${changePhrase(msg.concession, world)}.`;
    case 'Accept':
      return `${name(msg.from)} accepts${all.find((x) => x.id === msg.replyTo)?.type === 'CounterOffer' ? ' the counter' : ''} (terms ${msg.termsHash.slice(0, 12)}).`;
    case 'Reject':
      return `${name(msg.from)} declines: ${msg.reason}`;
    case 'Expire':
      return `The proposal to ${recipient(msg.ref)} lapsed because a change it depended on was not agreed.`;
    case 'Withdraw':
      return `${name(msg.from)} withdraws ${msg.offer}: ${msg.reason}`;
    case 'RequestQuote':
      return `Quote request to ${name(msg.to)} for ${msg.qty} on ${msg.stage}.`;
  }
}

/**
 * Full negotiation loop under a supplier query budget: interventions, value-of-information questions,
 * typed proposals, private policy decisions, counters, accepted concessions, re-solve and independent
 * verification. Acceptance is decided only by supplier policies or the seller terminal.
 */
export async function negotiate(
  world: World,
  intent: Intent,
  truth: TruthLike,
  opts: NegotiateOptions = {},
): Promise<NegotiationRun> {
  const solver = opts.solver ?? (await loadSolver());
  const clock = new Clock(opts.now ?? world.createdAt);
  const startedAt = clock.peek();
  const id = `neg-${world.id}-v${world.version}-${intent.id}`;
  const budget = opts.budget ?? 6;

  const before = await solver.solve(world, intent);
  const run: NegotiationRun = {
    id,
    worldId: world.id,
    worldVersionBefore: world.version,
    intent: intent.id,
    outcome: 'no-interventions',
    queryBudget: budget,
    queriesUsed: 0,
    interventions: [],
    outcomeModel: { solves: 0, ms: 0, feasibleSets: 0 },
    questions: [],
    messages: [],
    decisions: [],
    texts: [],
    accepted: [],
    rejected: [],
    coalitions: [],
    pendingBuyerQuestions: [],
    before,
    startedAt,
    finishedAt: startedAt,
  };

  if (before.plan && feasible(before.status)) {
    run.verification = solver.verifyPlan(before.plan, world, intent);
    run.after = before;
    run.world = world;
    run.intentAfter = intent;
    run.outcome = run.verification.ok ? 'already-feasible' : 'unverified';
    run.finishedAt = clock.peek();
    return run;
  }

  const interventions = (await solver.findInterventions(world, intent, { k: opts.k ?? 5, ...(opts.maxChanges ? { maxChanges: opts.maxChanges } : {}) }))
    .filter((i) => i.unlocks && i.concessions.length > 0);
  run.interventions = interventions;
  if (!interventions.length) {
    run.finishedAt = clock.peek();
    return run;
  }

  const outcomes = await simulateOutcomes(world, intent, interventions, solver, { maxSolves: opts.maxSolves ?? 24 });
  run.outcomeModel = { solves: outcomes.solves, ms: outcomes.ms, feasibleSets: outcomes.feasibleSets.length };
  run.questions = selectQuestions(world, intent, interventions, budget, { outcomes, now: startedAt, idPrefix: `${id}:plan:q` });

  const desk = createSupplierDesk(truth, world, opts.terminal);
  const coalitions: Coalition[] = interventions.flatMap((i) => (i.coalition ? [i.coalition] : []));
  const charges = new Map<string, Concession>();
  const answers = new Map<string, boolean>();
  const secured = new Set<string>();
  const acceptedBy = new Map<string, Concession>();
  const benefits = new Map<string, string>();
  const pending = new Map<string, RankedQuestion>();
  let msgNo = 0;
  const nextId = () => `${id}:m${++msgNo}`;
  const push = (m: NegotiationMessage) => run.messages.push(m);

  const evaluate = async (cs: Concession[]) => {
    let next: { world: World; intent: Intent };
    try {
      next = applyAll(solver, world, intent, cs);
    } catch (e) {
      const report: SolveReport = { status: 'error', solver: { name: 'apply', version: '0', ms: 0 } };
      return { report, verification: undefined, world, intent, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const report = await solver.solve(next.world, next.intent, { explain: false });
    const verification = report.plan && feasible(report.status) ? solver.verifyPlan(report.plan, next.world, next.intent) : undefined;
    return { report, verification, world: next.world, intent: next.intent, ok: !!verification?.ok };
  };
  const withCharges = (keys: Iterable<string>) =>
    [...keys].flatMap((k) => [acceptedBy.get(k), charges.get(k)]).filter((c): c is Concession => !!c);
  const securedConcessions = () => withCharges(secured);

  let final: Awaited<ReturnType<typeof evaluate>> | undefined;
  let rounds = 0;

  while (run.queriesUsed < budget && rounds++ < 50) {
    const plan = selectQuestions(world, intent, interventions, budget - run.queriesUsed, {
      outcomes,
      answers,
      secured,
      now: clock.peek(),
      idPrefix: `${id}:r${rounds}:q`,
    });
    if (!plan.length) break;
    const group = plan.filter((q) => q.group === plan[0]!.group);

    let blocked = false;
    for (const q of group.filter((g) => g.buyerQuestion)) {
      const key = concessionKey(q.concession);
      const consent = opts.buyerConsent?.(q.concession);
      if (consent === undefined) {
        pending.set(key, q);
        answers.set(key, false);
        blocked = true;
        continue;
      }
      const ask = { ...(q.message as Extract<QuestionMessage, { type: 'AskPreference' }>), id: nextId(), at: clock.next() };
      push(ask);
      benefits.set(ask.id, q.benefit);
      answers.set(key, consent);
      if (consent) {
        secured.add(key);
        acceptedBy.set(key, q.concession);
        push({ type: 'Accept', id: nextId(), from: ask.to, to: ask.from, replyTo: ask.id, termsHash: sha256(termsOf(q.concession)), at: clock.next() });
      } else {
        blocked = true;
        run.rejected.push(q.concession);
        push({ type: 'Reject', id: nextId(), from: ask.to, to: ask.from, replyTo: ask.id, reason: 'The buyer keeps this term.', at: clock.next() });
      }
    }
    if (blocked) continue;

    const supplierQs = group.filter((g) => !g.buyerQuestion);
    const idMap = new Map(supplierQs.map((q) => [q.message.id, nextId()]));
    const proposalOf = new Map<string, string>();
    const groupYes: string[] = [];
    let failed = false;

    for (let i = 0; i < supplierQs.length; i++) {
      const q = supplierQs[i]!;
      if (run.queriesUsed >= budget) {
        failed = true;
        break;
      }
      const key = concessionKey(q.concession);
      const at = clock.next();
      const mid = idMap.get(q.message.id)!;
      const msg: QuestionMessage =
        q.message.type === 'Propose'
          ? {
              ...q.message,
              id: mid,
              at,
              expires: new Date(Date.parse(at) + 24 * HOUR).toISOString(),
              ...(q.message.conditional ? { conditional: q.message.conditional.map((c) => idMap.get(c) ?? c) } : {}),
            }
          : { ...q.message, id: mid, at };
      push(msg);
      benefits.set(mid, q.benefit);
      proposalOf.set(key, mid);
      run.queriesUsed++;

      const d: SupplierDecision = desk.respond(msg, { coalitions });
      run.decisions.push(d);
      if (d.accept) {
        push({ type: 'Accept', id: nextId(), from: msg.to, to: msg.from, replyTo: mid, termsHash: sha256(termsOf(q.concession)), at: clock.next() });
        answers.set(key, true);
        acceptedBy.set(key, q.concession);
        groupYes.push(key);
        continue;
      }
      if (d.counter) {
        const counterId = nextId();
        const cat = clock.next();
        push({ type: 'CounterOffer', id: counterId, from: msg.to, to: msg.from, replyTo: mid, concession: d.counter, expires: new Date(Date.parse(cat) + 24 * HOUR).toISOString(), at: cat });
        const charge = isCharge(q.concession, d.counter);
        const rest = supplierQs.slice(i + 1).map((r) => r.concession);
        const offered = charge ? [q.concession, d.counter] : [d.counter];
        const trial = await evaluate([...securedConcessions(), ...withCharges(groupYes), ...offered, ...rest]);
        if (trial.ok) {
          push({ type: 'Accept', id: nextId(), from: msg.from, to: msg.to, replyTo: counterId, termsHash: sha256(offered.map(termsOf)), at: clock.next() });
          answers.set(key, true);
          acceptedBy.set(key, charge ? q.concession : d.counter);
          if (charge) charges.set(key, d.counter);
          groupYes.push(key);
          continue;
        }
        push({ type: 'Reject', id: nextId(), from: msg.from, to: msg.to, replyTo: counterId, reason: 'The countered term does not make the order feasible.', at: clock.next() });
      } else {
        push({ type: 'Reject', id: nextId(), from: msg.to, to: msg.from, replyTo: mid, reason: d.reason, at: clock.next() });
      }
      answers.set(key, false);
      run.rejected.push(q.concession);
      failed = true;
      break;
    }

    if (failed) {
      for (const k of groupYes) {
        if (supplierQs.length > 1) push({ type: 'Expire', id: nextId(), ref: proposalOf.get(k)!, at: clock.next() });
        acceptedBy.delete(k);
        charges.delete(k);
      }
      continue;
    }
    for (const k of groupYes) secured.add(k);
    const res = await evaluate(securedConcessions());
    if (res.ok) {
      final = res;
      break;
    }
  }

  run.accepted = securedConcessions();
  run.coalitions = coalitions.filter((co) => run.accepted.some((c) => c.target.kind === 'offer' && c.target.field === 'joint' && namesCoalition(c.to, co.id)));
  run.pendingBuyerQuestions = [...pending.values()];
  const end = final ?? (run.accepted.length ? await evaluate(run.accepted) : undefined);
  if (end) {
    run.after = end.report;
    if (end.verification) run.verification = end.verification;
    run.world = end.world;
    run.intentAfter = end.intent;
  }
  run.outcome = end?.ok
    ? 'feasible'
    : end?.report.plan && feasible(end.report.status)
      ? 'unverified'
      : run.queriesUsed >= budget
        ? 'budget-exhausted'
        : pending.size
          ? 'needs-buyer-consent'
          : 'refused';
  run.texts = run.messages.map((m): MessageText => ({ message: m.id, text: messageText(m, world, benefits, run.messages), source: 'template' }));
  run.finishedAt = clock.peek();
  return run;
}
