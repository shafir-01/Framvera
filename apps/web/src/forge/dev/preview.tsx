import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import wasmUrl from 'highs/runtime?url';
import '@fontsource-variable/geist';
import '@fontsource-variable/newsreader';
import '../../styles.css';
import { Forge } from '../index.tsx';
import { intent, outside, world } from './fixture.ts';

// Preview only: point the solver's wasm fetch at the bundled file until the shared worker module is mounted.
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return realFetch(/highs[^/]*\.wasm/.test(url) ? wasmUrl : input, init);
}) as typeof fetch;

function Page() {
  const [sent, setSent] = useState<string>('');
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 24px' }}>
      <Forge world={world} intent={intent} outside={outside} stage="delivery" onPropose={(c) => setSent(JSON.stringify(c, null, 1))} />
      {sent ? <pre style={{ fontSize: 11, marginTop: 24, opacity: 0.7 }}>{sent}</pre> : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
