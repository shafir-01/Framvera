import type { Intent, World } from '@framvera/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Engine {
  flagshipWorld?: () => { world: World; intent: Intent; truth: any };
  generateWorld?: (seed: number, family: string) => { world: World; intent: Intent; truth: any };
  solve?: (...a: any[]) => Promise<any>;
  explainInfeasible?: (...a: any[]) => Promise<any>;
  findInterventions?: (...a: any[]) => Promise<any>;
  synthesizeCoalitions?: (...a: any[]) => any;
  verifyPlan?: (...a: any[]) => any;
  negotiate?: (...a: any[]) => Promise<any>;
  challengeClaims?: (...a: any[]) => any;
  compileIntent?: (...a: any[]) => Promise<any>;
  commit?: (...a: any[]) => any;
  disrupt?: (...a: any[]) => any;
  recover?: (...a: any[]) => Promise<any>;
  Ledger?: new (path: string) => any;
  PayPalSandboxAdapter?: new (...a: any[]) => any;
  FakeGateway?: new (...a: any[]) => any;
  hashTerms?: (o: unknown) => string;
}

export class Unavailable extends Error {
  constructor(public what: string) {
    super(`${what} is not available`);
  }
}

export function need<T>(fn: T | undefined, what: string): T {
  if (typeof fn !== 'function') throw new Unavailable(what);
  return fn;
}

const MODULES = ['contracts', 'market', 'solver', 'negotiation', 'obligations', 'paypal'];

export async function loadEngine(): Promise<Engine> {
  const engine: Record<string, unknown> = {};
  for (const m of MODULES) {
    try {
      Object.assign(engine, await import(/* @vite-ignore */ `@framvera/${m}`));
    } catch {
      /* module not built yet; routes depending on it answer 501 */
    }
  }
  return engine as Engine;
}

export function availability(e: Engine) {
  const has = (...k: (keyof Engine)[]) => k.every((x) => typeof e[x] === 'function');
  return {
    market: has('flagshipWorld'),
    solver: has('solve', 'verifyPlan'),
    inverse: has('findInterventions'),
    negotiation: has('negotiate'),
    obligations: has('commit', 'recover', 'Ledger'),
    paypalAdapter: has('PayPalSandboxAdapter'),
  };
}
