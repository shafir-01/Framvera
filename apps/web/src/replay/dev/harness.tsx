// Development harness only. Render it from a scratch entry; it is never imported by the app.
import { Replay } from '../index.tsx';
import { replayProps } from './fixture.ts';

export function ReplayHarness() {
  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: 32 }}>
      <Replay {...replayProps} />
    </div>
  );
}
