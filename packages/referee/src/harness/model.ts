import Anthropic from '@anthropic-ai/sdk';
import { MODEL_ID, Meter } from './meter.ts';

export interface ModelRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export interface ModelClient {
  create(req: ModelRequest): Promise<Anthropic.Message>;
}

/** Live client. The key is read from the environment and never logged. Retries are off so the call count is exact. */
export function liveModel(meter: Meter): ModelClient {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 });
  return {
    async create(req) {
      meter.reserve();
      try {
        const res = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 8000,
          system: req.system,
          tools: req.tools,
          messages: req.messages,
        });
        meter.record(res.usage);
        return res;
      } catch (e) {
        meter.failed();
        throw e instanceof Anthropic.APIError ? new Error(`model request failed (${e.status ?? 'network'})`) : e;
      }
    },
  };
}
