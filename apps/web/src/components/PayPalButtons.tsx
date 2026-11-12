import { useEffect, useRef, useState } from 'react';

interface ButtonsInstance {
  render(el: HTMLElement): Promise<void>;
  close?(): Promise<void>;
  isEligible?(): boolean;
}

interface PayPalNamespace {
  Buttons(opts: {
    style?: Record<string, unknown>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (err: unknown) => void;
  }): ButtonsInstance;
}

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

const loads = new Map<string, Promise<PayPalNamespace>>();

function loadSdk(clientId: string, currency: string): Promise<PayPalNamespace> {
  const key = `${clientId}|${currency}`;
  const known = loads.get(key);
  if (known) return known;
  const p = new Promise<PayPalNamespace>((resolve, reject) => {
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons`;
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.dataset.namespace = 'paypal';
    el.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal did not load.')));
    el.onerror = () => {
      loads.delete(key);
      reject(new Error('PayPal could not be reached.'));
    };
    document.head.appendChild(el);
  });
  loads.set(key, p);
  return p;
}

interface Props {
  clientId: string;
  currency: string;
  label: string;
  createOrder: () => Promise<string>;
  onApprove: (orderId: string) => Promise<void>;
  onError: (message: string) => void;
}

export function PayPalButtons({ clientId, currency, label, createOrder, onApprove, onError }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const handlers = useRef({ createOrder, onApprove, onError });
  handlers.current = { createOrder, onApprove, onError };

  useEffect(() => {
    let alive = true;
    let inst: ButtonsInstance | undefined;
    setState('loading');
    loadSdk(clientId, currency)
      .then(async (pp) => {
        if (!alive || !slot.current) return;
        const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
        inst = pp.Buttons({
          style: { layout: 'horizontal', color: dark ? 'white' : 'black', shape: 'rect', label: 'pay', height: 44, tagline: false },
          createOrder: () => handlers.current.createOrder(),
          onApprove: (data) => handlers.current.onApprove(data.orderID),
          onCancel: () => handlers.current.onError('Approval was cancelled in PayPal. Nothing was captured.'),
          onError: () => handlers.current.onError('PayPal reported an error. Check the proof drawer before retrying.'),
        });
        slot.current.innerHTML = '';
        await inst.render(slot.current);
        if (alive) setState('ready');
      })
      .catch((e: Error) => {
        if (!alive) return;
        setState('failed');
        handlers.current.onError(e.message);
      });
    return () => {
      alive = false;
      inst?.close?.().catch(() => {});
    };
  }, [clientId, currency]);

  return (
    <div>
      <div ref={slot} className="pp-slot" aria-label={label} />
      {state === 'loading' ? <div className="fine">Loading PayPal…</div> : null}
    </div>
  );
}
