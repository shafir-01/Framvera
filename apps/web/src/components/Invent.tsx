import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Concession, Id, NegotiationMessage, Offer, SupplierDecision } from '@framvera/contracts';
import { useStore } from '../store.tsx';
import { concessionSentence, count, money } from '../lib/format.ts';
import { Copy, Drawer, ErrorNote, SourceTag, Waiting } from './ui.tsx';
import { OpportunityMap } from './OpportunityMap.tsx';
import { solveTime } from './Discover.tsx';
import { InspectOffer } from './Inspect.tsx';
import type { QuestionView, SeatLink } from '../api.ts';
import { errorText } from '../store.tsx';

function concessionOf(m: NegotiationMessage): Concession | undefined {
  if (m.type === 'AskPreference') return m.question;
  if (m.type === 'Propose' || m.type === 'CounterOffer') return m.concession;
  return undefined;
}

function SeatDrawer({ open, onClose, actors }: { open: boolean; onClose: () => void; actors: { id: Id; name: string }[] }) {
  const { api, s } = useStore();
  const [links, setLinks] = useState<Record<Id, SeatLink>>({});
  const [busy, setBusy] = useState<Id | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const market = s.market?.market;
  const abs = (link: string) => new URL(link, location.origin + location.pathname).toString();
  return (
    <Drawer open={open} onClose={onClose} label="Answer for a supplier" eyebrow="Seller terminal" title="Let a person answer for a supplier">
      <p className="fine" style={{ fontSize: 14, margin: 0 }}>
        One person answers this supplier’s questions instead of its policy. Single use, expires in 30 minutes.
      </p>
      {err ? <ErrorNote title="No seat link was created.">{err}</ErrorNote> : null}
      <ul className="msg-list">
        {actors.map((a) => {
          const l = links[a.id];
          return (
            <li key={a.id} className="proof-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <div>
                <div style={{ fontWeight: 540 }}>{a.name}</div>
                {l ? (
                  <div className="mono" style={{ color: 'var(--ink-3)', marginTop: 4, overflowWrap: 'anywhere' }}>
                    {abs(l.link)}
                    <Copy text={abs(l.link)} label={`seat link for ${a.name}`} />
                  </div>
                ) : null}
              </div>
              {l ? (
                <a className="btn btn-quiet btn-small" href={abs(l.link)} target="_blank" rel="noopener">
                  Open
                </a>
              ) : (
                <button
                  className="btn btn-quiet btn-small"
                  disabled={!market || busy === a.id}
                  onClick={async () => {
                    if (!market) return;
                    setBusy(a.id);
                    setErr(null);
                    try {
                      const r = await api.mintSeat(market, a.id);
                      setLinks((x) => ({ ...x, [a.id]: r }));
                    } catch (e) {
                      setErr(errorText(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === a.id ? 'Creating…' : 'Create link'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

function Answer({ decision, name, counter }: { decision?: SupplierDecision; name: string; counter?: string }) {
  if (!decision) return <span className="verdict">No answer recorded</span>;
  const person = decision.basis === 'seller-terminal';
  return (
    <>
      <span className="verdict" data-ok={decision.accept}>
        <span className="verdict-dot" aria-hidden="true" />
        {decision.accept ? 'Accepted' : decision.counter ? 'Countered' : 'Declined'}
      </span>
      <div className="qa-reason">“{decision.reason}”</div>
      {counter ? <div className="qa-why">Counter: {counter}</div> : null}
      <div className="qa-meta" style={{ marginTop: 10, marginBottom: 0 }}>
        {person ? <SourceTag kind="terminal" /> : <SourceTag kind="policy" />}
        {person ? null : <SourceTag kind="synthetic" />}
      </div>
    </>
  );
}

export function Invent() {
  const { s, act, world } = useStore();
  const [inspect, setInspect] = useState<Offer | null>(null);
  const [seats, setSeats] = useState(false);
  const inv = s.invention;
  const neg = s.negotiation;
  const baseWorld = s.market?.world;
  const mapWorld = neg?.world ?? world ?? baseWorld;

  const top = useMemo(() => {
    const list = (neg?.interventions.length ? neg.interventions : inv?.interventions) ?? [];
    return list.find((i) => i.unlocks);
  }, [inv, neg]);

  if (!s.analysis || s.analysis.report.status !== 'infeasible' || !baseWorld) return null;
  const inventing = s.busy === 'invent' || (!inv && !s.error);
  const coalition = top?.coalition ?? inv?.coalitions.find((c) => top?.concessions.some((x) => x.target.kind === 'offer' && c.inputs.some((i) => i.offer === (x.target as { offer: Id }).offer))) ?? inv?.coalitions[0];
  const touched = new Set<Id>((top?.concessions ?? []).flatMap((c) => (c.target.kind === 'offer' ? [c.target.offer] : [])));
  const disputed = new Set<Id>();
  for (const f of inv?.findings ?? []) {
    if (f.verdict !== 'contradicted' && f.kind !== 'injection') continue;
    for (const o of baseWorld.offers) if (o.claims.includes(f.claim)) disputed.add(o.id);
  }
  const gone = new Set<Id>(s.disruption?.disruption.actor ? [s.disruption.disruption.actor] : []);
  const plan = neg?.report?.plan;
  const name = (id: Id | undefined) => mapWorld?.actors.find((a) => a.id === id)?.name ?? id ?? '–';
  const offerActor = (c: Concession) => (c.target.kind === 'offer' ? baseWorld.offers.find((o) => o.id === (c.target as { offer: Id }).offer)?.actor : undefined);
  const askActors = [...new Map((top?.concessions ?? []).map((c) => offerActor(c)).filter((x): x is Id => !!x).map((id) => [id, { id, name: name(id) }])).values()];

  const questions: QuestionView[] = (neg?.messages ?? [])
    .filter((m) => m.type === 'AskPreference' || m.type === 'Propose')
    .map((m) => {
      const c = concessionOf(m);
      const ranked = neg?.questions.find((q) => q.message.id === m.id || (c && q.concession?.id === c.id));
      return { message: m, voi: ranked?.voi ?? 0, concession: c, benefit: ranked?.benefit };
    });
  const decisionFor = (id: Id) => neg?.decisions.find((d) => d.message === id) ?? s.events.map((e) => (e.type === 'negotiation.decision' ? (e.data as SupplierDecision) : null)).find((d) => d?.message === id) ?? undefined;
  const unlocked = neg?.accepted ?? [];
  const supplierCost = unlocked.reduce((a, c) => a + (c.estimate?.minor ?? 0), 0);
  const intent = s.intent!;
  const headroom = plan ? intent.budget.minor - plan.total.minor : 0;
  const verification = neg?.verification;
  const after = neg?.report;

  const heading = plan ? (
    <>
      Framvera found a deal <em>no supplier offered.</em>
    </>
  ) : neg ? (
    'The suppliers did not make it possible.'
  ) : top ? (
    `${count(top.concessions.length, 'small change')} would make it possible.`
  ) : inv ? (
    'No change within reach makes it possible.'
  ) : (
    'Searching for the smallest change that works.'
  );

  return (
    <section className="act" id="invent" tabIndex={-1} aria-labelledby="invent-h">
      <div className="act-head">
        <div className="act-num">Invent</div>
        <h2 className="h2" id="invent-h" aria-live="polite">
          {heading}
        </h2>
        {top && !plan && top.coalition ? <p className="lede">{`Suppliers who never quoted together can cover it jointly, if ${count(askActors.length, 'of them agrees', 'of them agree')}.`}</p> : null}
      </div>

      {inventing ? <Waiting>Searching changes to prices, times and partnerships</Waiting> : null}
      {s.error?.step === 'invent' ? <ErrorNote title="The search for a change failed.">{s.error.message}</ErrorNote> : null}

      {mapWorld && inv ? (
        <>
          <OpportunityMap world={mapWorld} coalition={coalition} touched={touched} plan={plan} disputed={disputed} gone={gone} onInspect={setInspect} />
          <div className="legend">
            <span>
              <i style={{ border: '1.5px solid var(--accent)', background: 'var(--accent-soft)' }} />
              New arrangement
            </span>
            {plan ? (
              <span>
                <i style={{ border: '1.5px solid var(--ink-2)' }} />
                In the plan
              </span>
            ) : null}
            <SourceTag kind="synthetic" />
          </div>
        </>
      ) : null}

      <div className="invent-grid">
        {top && !neg && !s.awaiting ? (
          <div>
            <div className="h3">What Framvera will ask</div>
            <ol className="qa">
              {top.concessions.map((c) => (
                <li className="qa-item" key={c.id} style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                  <div className="qa-q">
                    <div className="qa-meta">
                      <span>To {name(offerActor(c)) || 'you'}</span>
                      <SourceTag kind="estimate">{`Costs them about ${money(c.estimate)}`}</SourceTag>
                    </div>
                    <div className="qa-text">{concessionSentence(c, baseWorld)}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 20, alignItems: 'center' }}>
              <button className="btn btn-accent" onClick={() => void act.ask()} disabled={s.busy === 'negotiate'}>
                {s.busy === 'negotiate' ? 'Asking…' : `Ask ${askActors.length === 1 ? askActors[0]!.name : 'the suppliers'}`}
              </button>
              {askActors.length ? (
                <button className="btn btn-quiet" onClick={() => setSeats(true)}>
                  Hand a supplier to a person
                </button>
              ) : null}
            </div>
            {s.busy === 'negotiate' ? <Waiting>Waiting for answers</Waiting> : null}
            {s.error?.step === 'negotiate' ? (
              <div style={{ marginTop: 16 }}>
                <ErrorNote title="The questions could not be sent." onRetry={() => void act.ask()}>
                  {s.error.message}
                </ErrorNote>
              </div>
            ) : null}
          </div>
        ) : null}

        {s.awaiting ? (
          <div className="notice" role="status" aria-live="polite" style={{ padding: '20px 22px' }}>
            <span className="pulse" aria-hidden="true" style={{ marginTop: 6 }} />
            <div>
              <strong>Waiting for the person answering for {s.awaiting.actorName}.</strong>
              <div style={{ marginTop: 6 }}>{concessionOf(s.awaiting.message) ? concessionSentence(concessionOf(s.awaiting.message)!, baseWorld) : 'A proposal is open.'}</div>
            </div>
          </div>
        ) : null}

        {neg && questions.length ? (
          <div>
            <div className="h3">
              Questions sent <span className="count">{questions.length}</span>
            </div>
            <ol className="qa">
              <AnimatePresence initial>
                {questions.map((q, i) => {
                  const c = q.concession ?? concessionOf(q.message);
                  const to = 'to' in q.message ? q.message.to : undefined;
                  const d = decisionFor(q.message.id);
                  const counter = d?.counter ? concessionSentence(d.counter, baseWorld) : undefined;
                  const text = neg.texts.find((t) => t.message === q.message.id);
                  return (
                    <motion.li className="qa-item" key={q.message.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 * i, duration: 0.4 }}>
                      <div className="qa-q">
                        <div className="qa-meta">
                          <span>To {name(to)}</span>
                          {c?.estimate ? <SourceTag kind="estimate">{`${money(c.estimate)} to them`}</SourceTag> : null}
                        </div>
                        <div className="qa-text">{c ? concessionSentence(c, baseWorld) : q.message.type}</div>
                        {text ? (
                          <div className="qa-why">
                            Sent as: “{text.text}” {text.source === 'model-proposal' ? <SourceTag kind="estimate">Drafted wording</SourceTag> : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="qa-a">
                        <Answer decision={d} name={name(to)} counter={counter} />
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ol>
          </div>
        ) : null}

        {neg && plan && after ? (
          <motion.div className="unlock" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }} aria-live="polite">
            <div className="unlock-main">
              <div className="eyebrow">Possible now</div>
              <div className="unlock-total">{money(plan.total)}</div>
              <div className="unlock-sub">
                <strong>{money({ currency: plan.total.currency, minor: Math.abs(headroom) })}</strong> {headroom >= 0 ? 'under' : 'over'} your {money(intent.budget)} budget{plan.readyAt ? `, ready ${new Date(plan.readyAt) <= new Date(intent.deadline) ? 'before' : 'after'} the deadline` : ''}.
              </div>
              <div className="rerun" style={{ marginTop: 18 }}>
                <SourceTag kind="solver">
                  Re-solved · {solveTime(after.solver.ms)}
                </SourceTag>
                {verification ? (
                  <span>
                    {verification.checks.filter((c) => c.ok).length} of {verification.checks.length} independent checks pass
                  </span>
                ) : null}
              </div>
            </div>
            <div className="unlock-side">
              <div>
                <div className="h3">Unlocked by</div>
                <ol>
                  {unlocked.map((c, i) => (
                    <li key={c.id}>
                      <span className="i">{String(i + 1).padStart(2, '0')}</span>
                      <span>{concessionSentence(c, baseWorld)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              {supplierCost ? (
                <div className="fine">
                  The changes cost the suppliers about {money({ currency: plan.total.currency, minor: supplierCost })} <SourceTag kind="estimate" />, already inside the total.
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}

        {neg && !plan ? (
          <ErrorNote title={neg.outcome === 'needs-buyer-consent' ? 'The remaining change needs your consent.' : 'No accepted combination made the order possible.'}>
            {neg.pendingBuyerQuestions.length
              ? neg.pendingBuyerQuestions.map((q) => (q.concession ? concessionSentence(q.concession, baseWorld) : '')).join(' · ')
              : `Outcome: ${neg.outcome}. ${neg.rejected.length ? `${count(neg.rejected.length, 'change')} declined.` : ''}`}
          </ErrorNote>
        ) : null}
      </div>

      <InspectOffer offer={inspect} world={mapWorld} onClose={() => setInspect(null)} />
      <SeatDrawer open={seats} onClose={() => setSeats(false)} actors={askActors} />
    </section>
  );
}
