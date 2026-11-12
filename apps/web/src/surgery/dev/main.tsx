import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InfeasibleCore, Intent, Intervention, World } from '@framvera/contracts';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '../../styles.css';
import { Surgery, type SurgeryBranch } from '../index.tsx';
import data from './flagship.json';
import { probe } from './probe.ts';

const root = document.getElementById('root')!;
const params = new URLSearchParams(location.search);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme')!;

function Harness() {
  const [sent, setSent] = useState<SurgeryBranch[]>([]);
  return (
    <main style={{ maxWidth: 1240, margin: '0 auto', padding: '40px var(--gutter) 80px' }}>
      <Surgery
        world={data.world as unknown as World}
        intent={data.intent as unknown as Intent}
        core={data.core as unknown as InfeasibleCore}
        interventions={data.interventions as unknown as Intervention[]}
        onCommitBranch={(b) => setSent((s) => [...s, b])}
      />
      <pre id="sent" className="fine" hidden={!sent.length}>
        {sent.map((b) => `${b.label}: ${b.concessions.length} concessions, agreed=${String(b.agreed)}, frozen=${Object.isFrozen(b)}`).join('\n')}
      </pre>
    </main>
  );
}

if (params.has('probe')) {
  probe(root).catch((e) => {
    root.dataset.done = '1';
    root.textContent = 'ERROR ' + (e instanceof Error ? e.message : String(e));
  });
} else {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
