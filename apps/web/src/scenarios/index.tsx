import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { day, money } from '../lib/format.ts';
import { httpClient } from './client.ts';
import { briefOf } from './graph.ts';
import { outcomeLine, runScenario } from './outcome.ts';
import { familyForSeed, parseSeed, randomSeed, TEMPLATE_SEEDS } from './seed.ts';
import { StageGraph, UnknownGraph } from './StageGraph.tsx';
import type { Outcome, ScenarioClient, ScenarioGalleryProps, Started, StartedMarket, StartRequest, TemplateId } from './types.ts';
import './scenarios.css';

export type { ScenarioGalleryProps, Started } from './types.ts';

interface Card {
  id: Exclude<TemplateId, 'unseen'>;
  title: string;
  blurb: string;
  request: StartRequest;
}

const CARDS: Card[] = [
  { id: 'flagship', title: 'Promotional kits', blurb: 'Print, assemble, pack and ship 500 kits before a Friday deadline.', request: { template: 'flagship' } },
  { id: 'exhibition', title: 'Exhibition build', blurb: 'Equipment, venue, labour and freight that must line up for opening day.', request: { template: 'exhibition', ...TEMPLATE_SEEDS.exhibition } },
  { id: 'circular', title: 'Circular surplus exchange', blurb: 'Small firms hold goods and services the others need, with little cash between them.', request: { template: 'circular', ...TEMPLATE_SEEDS.circular } },
];

type Preview = { state: 'loading' } | { state: 'ready'; market: StartedMarket } | { state: 'error'; message: string };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function useClient(given?: ScenarioClient): ScenarioClient {
  const [dev, setDev] = useState<ScenarioClient | null>(null);
  useEffect(() => {
    if (given || !(import.meta.env.DEV && import.meta.env.VITE_FIXTURE === '1')) return;
    void import('./dev/fixtureClient.ts').then((m) => setDev(m.fixtureClient()));
  }, [given]);
  return useMemo(() => given ?? dev ?? httpClient(import.meta.env.VITE_API_URL ?? ''), [given, dev]);
}

function ResultLine({ outcome }: { outcome: Outcome }) {
  const line = outcomeLine(outcome);
  return (
    <div className="sc-result" role="status" data-tone={line.tone}>
      <strong>{line.label}</strong>
      {line.detail ? <small>{line.detail}</small> : null}
      {outcome.kind === 'impossible' && outcome.reasons.length > 0 ? (
        <ul className="sc-reasons">
          {outcome.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Facts({ m }: { m: StartedMarket }) {
  const b = briefOf(m.world, m.intent, money, day);
  return (
    <dl className="sc-facts">
      <div>
        <dt>Stages</dt>
        <dd>{b.chain.join(', ')}</dd>
      </div>
      <div>
        <dt>Suppliers</dt>
        <dd>{b.suppliers}</dd>
      </div>
      <div>
        <dt>Objective</dt>
        <dd>{b.objective}</dd>
      </div>
    </dl>
  );
}

export function ScenarioGallery({ onPick, runSolve = true, client: given }: ScenarioGalleryProps) {
  const client = useClient(given);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seedText, setSeedText] = useState('');
  const [seeded, setSeeded] = useState<Started | null>(null);

  const loadPreview = useCallback(
    (card: Card) => {
      setPreviews((p) => ({ ...p, [card.id]: { state: 'loading' } }));
      client.start(card.request).then(
        (market) => setPreviews((p) => ({ ...p, [card.id]: { state: 'ready', market } })),
        (e) => setPreviews((p) => ({ ...p, [card.id]: { state: 'error', message: messageOf(e) } })),
      );
    },
    [client],
  );

  useEffect(() => {
    for (const c of CARDS) loadPreview(c);
  }, [loadPreview]);

  const solve = useCallback(
    async (key: string, started: Started) => {
      pickRef.current(started);
      if (!runSolve) return;
      try {
        const o = await runScenario(client, started);
        setOutcomes((p) => ({ ...p, [key]: o }));
      } catch (e) {
        setErrors((p) => ({ ...p, [key]: messageOf(e) }));
      }
    },
    [client, runSolve],
  );

  const begin = useCallback(
    async (key: string, get: () => Promise<Started>) => {
      setBusy(key);
      setErrors((p) => ({ ...p, [key]: '' }));
      setOutcomes((p) => {
        const { [key]: _gone, ...rest } = p;
        return rest;
      });
      try {
        const started = await get();
        if (key === 'unseen') setSeeded(started);
        await solve(key, started);
      } catch (e) {
        setErrors((p) => ({ ...p, [key]: messageOf(e) }));
      } finally {
        setBusy(null);
      }
    },
    [solve],
  );

  const seedValue = parseSeed(seedText);
  const seedInvalid = seedText.trim() !== '' && seedValue === null;

  const startSeed = (seed: number) => {
    setSeedText(String(seed));
    setSeeded(null);
    void begin('unseen', async () => ({ ...(await client.start({ template: 'unseen', seed, family: familyForSeed(seed) })), template: 'unseen', seed }));
  };

  const seedOutcome = outcomes.unseen;
  const seedFamily = seeded?.seed !== undefined ? familyForSeed(seeded.seed) : undefined;

  return (
    <section className="sc-gallery" aria-label="Markets to try">
      {CARDS.map((card) => {
        const pv = previews[card.id];
        const ready = pv?.state === 'ready' ? pv.market : null;
        const outcome = outcomes[card.id];
        const tone = outcome ? (outcome.kind === 'made-possible' ? 'new' : outcome.kind === 'impossible' ? 'stop' : 'plain') : 'plain';
        return (
          <article className="sc-card" key={card.id} aria-busy={busy === card.id}>
            <div className="sc-art">
              {ready ? <StageGraph stages={ready.world.stages} tone={tone} label={`Stage chain: ${ready.world.stages.map((s) => s.name).join(', then ')}`} /> : <UnknownGraph label="Stage chain loading" />}
            </div>
            <div>
              <h3>{card.title}</h3>
              <p className="sc-blurb">{card.blurb}</p>
            </div>
            {ready ? <Facts m={ready} /> : null}
            {pv?.state === 'error' ? (
              <p className="sc-error" role="alert">
                {pv.message}{' '}
                <button className="btn btn-quiet btn-small" onClick={() => loadPreview(card)}>
                  Try again
                </button>
              </p>
            ) : null}
            <div className="sc-foot">
              {outcome ? <ResultLine outcome={outcome} /> : null}
              {errors[card.id] ? (
                <p className="sc-error" role="alert">
                  {errors[card.id]}
                </p>
              ) : null}
              <button
                className="btn btn-primary"
                disabled={!ready || busy !== null}
                onClick={() => ready && void begin(card.id, async () => ({ ...ready, template: card.id }))}
              >
                {busy === card.id ? 'Solving' : outcome ? 'Run again' : 'Try this market'}
              </button>
            </div>
          </article>
        );
      })}

      <article className="sc-card" aria-busy={busy === 'unseen'}>
        <div className="sc-art">
          {seeded ? (
            <StageGraph
              stages={seeded.world.stages}
              tone={seedOutcome?.kind === 'made-possible' ? 'new' : seedOutcome?.kind === 'impossible' ? 'stop' : 'plain'}
              label={`Stage chain: ${seeded.world.stages.map((s) => s.name).join(', then ')}`}
            />
          ) : (
            <UnknownGraph label="Stage chain not known until the market is made" />
          )}
        </div>
        <div>
          <h3>A market nobody has seen</h3>
          <p className="sc-blurb">A market generated from a number you choose. Whether it works is revealed after solving.</p>
        </div>
        {seeded ? <Facts m={seeded} /> : null}
        <div className="sc-seed">
          <input
            inputMode="numeric"
            aria-label="Seed"
            aria-invalid={seedInvalid}
            placeholder="Seed, for example 2718"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && seedValue !== null && busy === null) startSeed(seedValue);
            }}
          />
          <button className="btn btn-small" disabled={busy !== null} onClick={() => startSeed(randomSeed())}>
            Random
          </button>
        </div>
        {seedInvalid ? <p className="sc-hint">Use digits only, up to nine.</p> : null}
        <div className="sc-foot">
          {seedOutcome ? <ResultLine outcome={seedOutcome} /> : null}
          {seedOutcome && seedFamily ? <p className="sc-reveal">This market was generated as {seedFamily}.</p> : null}
          {errors.unseen ? (
            <p className="sc-error" role="alert">
              {errors.unseen}
            </p>
          ) : null}
          <button className="btn btn-primary" disabled={seedValue === null || busy !== null} onClick={() => seedValue !== null && startSeed(seedValue)}>
            {busy === 'unseen' ? 'Solving' : 'Make and solve'}
          </button>
        </div>
      </article>
    </section>
  );
}
