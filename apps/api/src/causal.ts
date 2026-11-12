import type { EventType } from '@framvera/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const idOf = (x: any): string | undefined => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : undefined);

/**
 * Links each market event to the earlier events it depends on, from the entity ids its data names.
 * Keys are entity references ("msg:<id>", "plan:<id>", "agreement:<id>", ...) mapped to the latest event that
 * introduced or changed them.
 */
export class CausalIndex {
  private refs = new Map<string, Map<string, string>>();

  private map(market: string) {
    let m = this.refs.get(market);
    if (!m) this.refs.set(market, (m = new Map()));
    return m;
  }

  get(market: string, keys: (string | undefined | null | false)[]): string[] {
    const m = this.map(market);
    const out: string[] = [];
    for (const k of keys) {
      const id = k ? m.get(k) : undefined;
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  private all(market: string, prefix: string): string[] {
    return [...new Set([...this.map(market).entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v))];
  }

  causes(market: string, type: EventType, d: any): string[] {
    d = d ?? {};
    const first = (...groups: string[][]) => groups.find((g) => g.length) ?? [];
    switch (type) {
      case 'world.created':
        return [];
      case 'intent.compiled':
        return this.get(market, ['world']);
      case 'solve.completed':
        if (d.verification) return this.get(market, [`plan:${d.plan}`]);
        return first(this.get(market, ['intent', 'world']));
      case 'intervention.found':
      case 'claim.challenged':
        return this.get(market, ['solve']);
      case 'negotiation.message': {
        const ref = d.replyTo ?? d.ref;
        if (ref) return this.get(market, [`msg:${ref}`]);
        if (Array.isArray(d.conditional) && d.conditional.length) {
          const c = this.get(market, d.conditional.map((x: string) => `msg:${x}`));
          if (c.length) return c;
        }
        if (d.type === 'Withdraw') return first(this.get(market, [`offer:${d.offer}`]), this.get(market, ['agreement']));
        if (d.type === 'Accept' && typeof d.replyTo !== 'string') return this.get(market, ['agreement']);
        return first(this.all(market, 'intervention:'), this.get(market, ['solve']));
      }
      case 'negotiation.decision':
        return this.get(market, [`msg:${d.message}`]);
      case 'offer.derived':
        return this.get(market, (d.concessions ?? []).map((c: string) => `concession:${c}`));
      case 'agreement.state': {
        const a = d.agreement ?? {};
        const plan = d.plan ?? a.plan;
        return [
          ...this.get(market, [a.version > 1 ? `agreement:${idOf(a)}` : null, `verify:${plan}`, `plan:${plan}`, d.recovery ? `recovery:${d.recovery}` : null]),
          ...this.get(market, (d.acceptedBy ?? []).map((m: string) => `msg:${m}`)),
        ];
      }
      case 'obligation.state': {
        const o = d.obligation ?? {};
        return this.get(market, [o.replaces ? `obligation:${o.replaces}` : null, `agreement:${o.agreement ?? d.agreement}`]);
      }
      case 'payment.state': {
        const p = d.payment ?? {};
        const pid = idOf(p);
        const prior = pid ? this.get(market, [`payment:${pid}`]) : [];
        if (prior.length) return prior;
        return this.get(market, [`agreement:${p.agreement ?? d.agreement}`, ...(p.obligations ?? []).map((o: string) => `obligation:${o}`)]);
      }
      case 'paypal.webhook':
        return this.get(market, [d.payment ? `payment:${d.payment}` : null]);
      case 'disruption.applied': {
        const hit = this.get(market, (d.affected ?? []).map((o: string) => `obligation:${o}`));
        return hit.length ? hit : this.get(market, [d.offer ? `offer:${d.offer}` : null, 'agreement']);
      }
      case 'recovery.proposed':
        return this.get(market, [`disruption:${d.recovery?.disruption ?? d.disruption}`]);
      case 'recovery.committed':
        return this.get(market, [`recovery:${idOf(d.recovery)}`]);
      default:
        return [];
    }
  }

  register(market: string, type: EventType, d: any, id: string) {
    const m = this.map(market);
    const set = (k: string | undefined | null | false) => k && m.set(k, id);
    d = d ?? {};
    switch (type) {
      case 'world.created':
        set('world');
        break;
      case 'intent.compiled':
        set('intent');
        break;
      case 'solve.completed':
        if (d.verification) set(`verify:${d.plan}`);
        else set('solve');
        if (!d.verification && d.plan) set(`plan:${d.plan}`);
        break;
      case 'intervention.found':
        set(`intervention:${d.id}`);
        for (const c of d.concessions ?? []) set(`concession:${c.id}`);
        break;
      case 'negotiation.message':
        set(`msg:${d.id}`);
        if (d.type === 'Withdraw') set(`offer:${d.offer}`);
        break;
      case 'negotiation.decision':
        set(`decision:${d.message}`);
        if (d.counter?.id) set(`concession:${d.counter.id}`);
        break;
      case 'agreement.state':
        set(`agreement:${idOf(d.agreement)}`);
        set('agreement');
        break;
      case 'obligation.state':
        set(`obligation:${idOf(d.obligation)}`);
        break;
      case 'payment.state':
        set(idOf(d.payment) && `payment:${idOf(d.payment)}`);
        break;
      case 'disruption.applied':
        set(`disruption:${idOf(d.disruption)}`);
        break;
      case 'recovery.proposed':
        set(`recovery:${idOf(d.recovery)}`);
        if (d.recovery?.plan?.id) set(`plan:${d.recovery.plan.id}`);
        break;
      case 'recovery.committed':
        set(`recovery:${idOf(d.recovery)}`);
        break;
    }
  }

  /** Records that a plan came out of a negotiation run, so verification and commit trace back to the deciding messages. */
  alias(market: string, key: string, id: string) {
    this.map(market).set(key, id);
  }
}
