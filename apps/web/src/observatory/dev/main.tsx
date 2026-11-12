import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { Api } from '../../api.ts';
import { Observatory } from '../index.tsx';
import { devProps, refetchPayment } from './fixture.ts';

const api = { payment: async (id: string) => refetchPayment(id)! } as unknown as Api;

function Harness() {
  const [theme, setTheme] = useState<'light' | 'dark'>(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.style.cssText = `margin:0;padding:24px;background:${theme === 'dark' ? '#111214' : '#f7f7f5'}`;
  return (
    <div style={{ height: 'calc(100vh - 48px)' }}>
      <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={{ marginBottom: 12 }}>
        Theme: {theme}
      </button>
      <Observatory {...devProps} api={api} theme={theme} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
