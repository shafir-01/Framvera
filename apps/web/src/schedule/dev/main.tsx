import '@fontsource-variable/geist';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Concession } from '@framvera/contracts';
import { Schedule } from '../index.ts';
import { scenario, type Scenario } from './fixture.ts';

const SCENARIOS: [Scenario, string][] = [['plan', 'Agreed'], ['disrupted', 'Supplier withdrew'], ['recovered', 'Recovered'], ['plain', 'Plan only']];

function Dev() {
  const params = new URLSearchParams(location.search);
  const [s, setS] = useState<Scenario>((params.get('s') as Scenario) ?? 'plan');
  const [dark, setDark] = useState(params.get('theme') === 'dark');
  const [log, setLog] = useState<Concession | null>(null);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return (
    <main>
      <div className="bar">
        {SCENARIOS.map(([k, l]) => (
          <button key={k} aria-pressed={s === k} onClick={() => setS(k)}>{l}</button>
        ))}
        <button aria-pressed={dark} onClick={() => setDark(!dark)}>Dark</button>
      </div>
      <Schedule {...scenario(s)} onAdjust={params.has('adjust') ? setLog : undefined} />
      {log && <pre data-testid="adjust">{JSON.stringify(log, null, 1)}</pre>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Dev /></StrictMode>);
