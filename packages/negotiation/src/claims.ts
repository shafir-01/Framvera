import type { Coalition, Id, Iso, Offer, Plan, World } from '@framvera/contracts';
import type { ClaimFindingDetail } from './types.ts';
import { fmtMoney, money, unitPriceAt } from './util.ts';

const INJECTION: RegExp[] = [
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|other|your)\s+(instructions?|rules|prompts?|messages|guidelines)/i,
  /\bdisregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your|other)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou\s+(are|must|should|will|shall)\s+(now\s+)?(always\s+)?(select|choose|pick|prefer|rank|recommend|approve|accept|pay|award)\b/i,
  /\b(always|must)\s+(select|choose|pick|prefer|rank|recommend|award)\b/i,
  /\b(select|choose|pick|rank|award)\s+(us|this\s+supplier|our\s+offer|me)\b/i,
  /\bas\s+an?\s+(ai|assistant|language\s+model|llm)\b/i,
  /\b(override|bypass|skip)\b[^.]{0,40}\b(rules?|policy|budget|verification|checks?|limits?)\b/i,
  /<\/?\s*(system|instructions?|prompt|assistant)\s*>/i,
  /\[\s*(system|inst|\/inst)\s*\]/i,
  /\b(new|updated|additional)\s+instructions?\b/i,
  /\bdo\s+not\s+(verify|check|tell|mention|report)\b/i,
  /\bmark\s+(this|it|us|the\s+order)\s+as\s+(verified|paid|approved|feasible)\b/i,
  /\bset\s+(the\s+)?(price|budget|total|score)\s+to\b/i,
];

const FEE_TEXT: RegExp[] = [
  /\b(excl\.?|excluding|exclusive\s+of|not\s+incl\.?|not\s+including|not\s+included|plus|\+)\s*(vat|moms|shipping|freight|delivery|transport|fees?|setup|overtime|handling|rush)\b/i,
  /\b(shipping|freight|delivery|transport|overtime|handling|rush)\s+(fees?|charges?|costs?|surcharges?)\s+(extra|apply|applies|additional|on\s+top|not\s+included|billed\s+separately)/i,
];

/** Instruction-like text inside supplier-provided content. Returned for flagging only; never acted on. */
export function detectInjection(text: string): string | undefined {
  for (const re of INJECTION) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

function feeMention(text: string): string | undefined {
  for (const re of FEE_TEXT) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
}

function quote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return `"${t.length > 60 ? `${t.slice(0, 57)}...` : t}"`;
}

/**
 * Challenges the evidence a plan relies on: capacity sold twice across offers or coalitions, expired
 * offers and claims, prices that leave out fees, contradicted claims, single-source capacity, and
 * instruction-like text in supplier descriptions. Supplier text is inspected as data only.
 * Every finding cites the record ids it rests on.
 */
export function challengeClaims(
  world: World,
  plan?: Plan,
  opts: { now?: Iso; coalitions?: Coalition[] } = {},
): ClaimFindingDetail[] {
  const now = Date.parse(opts.now ?? new Date().toISOString());
  const out: ClaimFindingDetail[] = [];
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const allocated = new Map<Id, number>();
  for (const a of plan?.allocations ?? []) allocated.set(a.offer, (allocated.get(a.offer) ?? 0) + a.qty);
  const relied: Offer[] = plan ? [...allocated.keys()].map((id) => offers.get(id)).filter((o): o is Offer => !!o) : world.offers;
  const reliedIds = new Set(relied.map((o) => o.id));
  const planRef = plan ? ` in plan ${plan.id}` : '';
  const flagged = new Set<Id>();
  const add = (f: ClaimFindingDetail) => {
    out.push(f);
    flagged.add(f.claim);
  };

  for (const actor of world.actors) {
    const hit = detectInjection(actor.description);
    if (hit) {
      add({
        claim: actor.id,
        verdict: 'unverifiable',
        kind: 'injection',
        records: [actor.id, ...world.offers.filter((o) => o.actor === actor.id).map((o) => o.id)],
        text: `Description of ${actor.id} (${actor.name}) contains instruction-like text ${quote(hit)}. It is treated as data and has no effect on ranking, negotiation or verification.`,
      });
    }
  }
  for (const claim of world.claims) {
    const hit = detectInjection(claim.assertion);
    if (hit) {
      add({
        claim: claim.id,
        verdict: 'unverifiable',
        kind: 'injection',
        records: [claim.id, claim.actor],
        text: `Claim ${claim.id} from ${claim.actor} contains instruction-like text ${quote(hit)}. It is treated as data only.`,
      });
    }
  }

  const capacityClaims = world.claims.filter((c) => c.subject.startsWith('capacity'));
  for (const claim of capacityClaims) {
    const subjectOffer = claim.subject.startsWith('capacity:') ? claim.subject.slice('capacity:'.length) : undefined;
    const users = world.offers.filter((o) => o.claims.includes(claim.id) || o.id === subjectOffer);
    const sameSubject = capacityClaims.filter((c) => c.id !== claim.id && c.actor === claim.actor && c.subject === claim.subject);
    for (const o of world.offers) {
      if (sameSubject.some((c) => o.claims.includes(c.id)) && !users.includes(o)) users.push(o);
    }
    if (claim.value === undefined || !users.length) continue;
    const used = users.reduce((a, o) => a + (allocated.get(o.id) ?? 0), 0);
    const ids = users.map((o) => o.id).join(', ');
    if (plan && used > claim.value) {
      add({
        claim: claim.id,
        verdict: 'contradicted',
        kind: 'double-booked',
        records: [claim.id, ...users.map((o) => o.id)],
        text: `Claim ${claim.id} backs ${claim.value} units, but ${ids}${planRef} draw ${used} units from it.`,
      });
      continue;
    }
    if (users.length > 1) {
      const offered = users.reduce((a, o) => a + o.capacity, 0);
      if (offered > claim.value && users.some((o) => reliedIds.has(o.id))) {
        add({
          claim: claim.id,
          verdict: 'unverifiable',
          kind: 'double-booked',
          records: [claim.id, ...users.map((o) => o.id)],
          text: `Offers ${ids} each rely on claim ${claim.id} (${claim.value} units) yet offer ${offered} units together; both cannot be filled in full.`,
        });
        continue;
      }
    }
    if (subjectOffer) {
      const o = offers.get(subjectOffer);
      if (o && o.capacity > claim.value && reliedIds.has(o.id)) {
        add({
          claim: claim.id,
          verdict: 'contradicted',
          kind: 'double-booked',
          records: [claim.id, o.id],
          text: `Offer ${o.id} advertises ${o.capacity} units but its own capacity claim ${claim.id} asserts ${claim.value}.`,
        });
      }
    }
  }

  for (const o of relied) {
    const bookings = world.claims.filter((c) => c.subject === `booked:${o.id}` && c.value !== undefined);
    if (!bookings.length) continue;
    const booked = bookings.reduce((a, c) => a + (c.value ?? 0), 0);
    const left = Math.max(0, o.capacity - booked);
    const used = allocated.get(o.id) ?? 0;
    const ids = bookings.map((c) => c.id);
    if (plan ? used > left : true) {
      add({
        claim: o.id,
        verdict: plan ? 'contradicted' : 'unverifiable',
        kind: 'double-booked',
        records: [o.id, ...ids],
        text: plan
          ? `Offer ${o.id} advertises ${o.capacity} units, but ${ids.join(', ')} already commit ${booked} elsewhere; plan ${plan.id} draws ${used} of the ${left} left.`
          : `Offer ${o.id} advertises ${o.capacity} units, but ${ids.join(', ')} already commit ${booked} elsewhere; only ${left} remain.`,
      });
    }
  }

  const coalitionUse = new Map<Id, { qty: number; refs: Id[] }>();
  for (const co of opts.coalitions ?? []) {
    for (const inp of co.inputs) {
      const cur = coalitionUse.get(inp.offer) ?? { qty: 0, refs: [] };
      cur.qty += inp.qty;
      cur.refs.push(co.id);
      coalitionUse.set(inp.offer, cur);
    }
  }
  for (const [offerId, use] of coalitionUse) {
    const o = offers.get(offerId);
    if (!o) continue;
    const direct = plan?.allocations.filter((a) => a.offer === offerId).reduce((s, a) => s + a.qty, 0) ?? 0;
    const refs = [...new Set(use.refs)];
    if (refs.length > 1 && use.qty > o.capacity) {
      add({
        claim: o.id,
        verdict: 'contradicted',
        kind: 'double-booked',
        records: [o.id, ...refs],
        text: `Offer ${o.id} has ${o.capacity} units but coalitions ${refs.join(', ')} commit ${use.qty} units of it.`,
      });
    } else if (direct && refs.length && use.qty + direct > o.capacity && !o.derivedFrom) {
      add({
        claim: o.id,
        verdict: 'contradicted',
        kind: 'double-booked',
        records: [o.id, ...refs],
        text: `Offer ${o.id} has ${o.capacity} units; coalition ${refs.join(', ')} uses ${use.qty} and the plan books another ${direct} directly.`,
      });
    }
  }

  for (const o of relied) {
    if (Date.parse(o.validUntil) < now) {
      add({
        claim: o.id,
        verdict: 'expired',
        kind: 'expired',
        records: [o.id],
        text: `Offer ${o.id} from ${o.actor} expired at ${o.validUntil}${plan ? ` but plan ${plan.id} uses it` : ''}.`,
      });
    }
    for (const cid of o.claims) {
      const c = world.claims.find((x) => x.id === cid);
      if (c?.expiresAt && Date.parse(c.expiresAt) < now) {
        add({
          claim: c.id,
          verdict: 'expired',
          kind: 'expired',
          records: [c.id, o.id],
          text: `Claim ${c.id} (${c.subject}) behind offer ${o.id} expired at ${c.expiresAt}.`,
        });
      }
    }
  }

  for (const a of plan?.allocations ?? []) {
    const o = offers.get(a.offer);
    if (!o || o.setupFee.minor <= 0) continue;
    const base = a.qty * unitPriceAt(o, a.qty);
    if (a.cost.minor < base + o.setupFee.minor && a.cost.minor >= base) {
      add({
        claim: o.id,
        verdict: 'contradicted',
        kind: 'fee-excluded',
        records: [o.id, plan!.id],
        text: `Allocation on ${o.id} in plan ${plan!.id} costs ${fmtMoney(a.cost)}, which leaves out its ${fmtMoney(o.setupFee)} setup fee.`,
      });
    }
  }
  for (const actor of world.actors) {
    const hit = feeMention(actor.description);
    if (!hit) continue;
    const theirs = relied.filter((o) => o.actor === actor.id);
    if (!theirs.length) continue;
    add({
      claim: actor.id,
      verdict: 'unverifiable',
      kind: 'fee-excluded',
      records: [actor.id, ...theirs.map((o) => o.id)],
      text: `${actor.id} (${actor.name}) states ${quote(hit)}, but offers ${theirs.map((o) => o.id).join(', ')} list no such fee; the true cost may exceed the planned ${fmtMoney(
        money(world.currency, theirs.reduce((s, o) => s + (allocated.get(o.id) ?? 0) * unitPriceAt(o, allocated.get(o.id) ?? 0), 0)),
      )}.`,
    });
  }

  const reliedClaimIds = new Set(relied.flatMap((o) => o.claims));
  for (const c of world.claims) {
    if (!reliedClaimIds.has(c.id)) continue;
    if (c.contradictedBy?.length) {
      add({
        claim: c.id,
        verdict: 'contradicted',
        kind: 'contradicted',
        records: [c.id, ...c.contradictedBy],
        text: `Claim ${c.id} (${c.assertion.slice(0, 80)}) is contradicted by ${c.contradictedBy.join(', ')}.`,
      });
      continue;
    }
    const rival = world.claims.find(
      (x) => x.id !== c.id && x.actor === c.actor && x.subject === c.subject && x.value !== undefined && c.value !== undefined && x.value !== c.value,
    );
    if (rival) {
      add({
        claim: c.id,
        verdict: 'contradicted',
        kind: 'contradicted',
        records: [c.id, rival.id],
        text: `Claims ${c.id} and ${rival.id} from ${c.actor} state different values for ${c.subject}: ${c.value} and ${rival.value}.`,
      });
    }
  }

  for (const o of relied) {
    for (const cid of o.claims) {
      const c = world.claims.find((x) => x.id === cid);
      if (!c || flagged.has(c.id)) continue;
      if (c.subject.startsWith('capacity') && (c.tier === 'single-claim' || c.tier === 'simulation-only')) {
        add({
          claim: c.id,
          verdict: 'unverifiable',
          kind: 'single-claim',
          records: [c.id, o.id],
          text: `Offer ${o.id} relies on capacity claim ${c.id}${c.value !== undefined ? ` (${c.value} units)` : ''}, backed only by the supplier's own word.`,
        });
      } else {
        add({
          claim: c.id,
          verdict: 'consistent',
          kind: 'consistent',
          records: [c.id, o.id],
          text: `Claim ${c.id} behind offer ${o.id} is ${c.tier} and not contradicted by any record.`,
        });
      }
    }
  }
  return out;
}
