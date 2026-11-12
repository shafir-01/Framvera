import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
import '../../styles.css';
import { EvidenceTrail } from '../index.tsx';
import { fixtureSource } from './fixture.ts';

const q = new URLSearchParams(location.search);
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme')!;
createRoot(document.getElementById('root')!).render(<EvidenceTrail market="mkt_evidence_fixture" entity={q.get('entity') ?? undefined} source={fixtureSource()} />);
