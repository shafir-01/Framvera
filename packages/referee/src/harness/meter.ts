import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_ID = 'claude-haiku-5-5';
export const CALL_BUDGET = 400;
/** Public list price per million tokens for the model above, prompts up to 100K tokens. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;

export interface SpendState {
  model: string;
  budgetCalls: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  usdEstimate: number;
  episodes: number;
  updatedAt: string;
}

export class BudgetExhausted extends Error {
  constructor(readonly limit: number) {
    super(`model call budget of ${limit} reached`);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const SPEND_FILE = resolve(root, '_internal/status/harness-spend.json');

function fresh(limit: number): SpendState {
  return { model: MODEL_ID, budgetCalls: limit, calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, usdEstimate: 0, episodes: 0, updatedAt: new Date().toISOString() };
}

/** Cumulative call and token ledger shared by every run, persisted after each call. */
export class Meter {
  state: SpendState;
  constructor(private readonly file: string | null = SPEND_FILE, private readonly limit = CALL_BUDGET) {
    this.state = file && existsSync(file) ? { ...fresh(limit), ...(JSON.parse(readFileSync(file, 'utf8')) as SpendState), budgetCalls: limit } : fresh(limit);
  }
  /** Reserves one call before it is sent, so failed requests still count. */
  reserve(): void {
    if (this.state.calls >= this.limit) throw new BudgetExhausted(this.limit);
    this.state.calls++;
    this.save();
  }
  record(usage: { input_tokens: number; output_tokens: number } | undefined): void {
    const i = usage?.input_tokens ?? 0;
    const o = usage?.output_tokens ?? 0;
    this.state.inputTokens += i;
    this.state.outputTokens += o;
    this.state.usdEstimate = Number(((this.state.inputTokens * PRICE_IN + this.state.outputTokens * PRICE_OUT) / 1e6).toFixed(6));
    this.save();
  }
  failed(): void {
    this.state.failedCalls++;
    this.save();
  }
  episode(): void {
    this.state.episodes++;
    this.save();
  }
  get remaining(): number {
    return this.limit - this.state.calls;
  }
  private save(): void {
    if (!this.file) return;
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
