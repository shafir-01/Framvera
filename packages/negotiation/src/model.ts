import Anthropic from '@anthropic-ai/sdk';

export const EXTRACT_MODEL = 'claude-sonnet-5-5';
export const CHEAP_MODEL = 'claude-haiku-5-5';

/** The part of the SDK client this package calls. Tests substitute it at this boundary. */
export type AnthropicLike = Pick<Anthropic, 'messages' | 'beta'>;

export function defaultClient(): AnthropicLike | undefined {
  return process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined;
}

export type ModelResult<T> = { ok: true; data: T; model: string } | { ok: false; error: string };

function errorLabel(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) return 'rate-limited';
  if (e instanceof Anthropic.AuthenticationError) return 'authentication-failed';
  if (e instanceof Anthropic.BadRequestError) return 'bad-request';
  if (e instanceof Anthropic.APIError) return `api-error-${e.status ?? 'unknown'}`;
  return 'request-failed';
}

/** Structured JSON output from the extraction model. The result is untrusted until validated by the caller. */
export async function structured<T>(
  client: AnthropicLike,
  args: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number },
): Promise<ModelResult<T>> {
  try {
    const res = await client.beta.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: args.maxTokens ?? 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: args.schema } },
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
    });
    if (res.stop_reason === 'refusal') return { ok: false, error: 'refusal' };
    if (res.stop_reason === 'max_tokens') return { ok: false, error: 'truncated' };
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      return { ok: true, data: JSON.parse(text) as T, model: res.model };
    } catch {
      return { ok: false, error: 'unparseable' };
    }
  } catch (e) {
    return { ok: false, error: errorLabel(e) };
  }
}

/** Short plain text from the inexpensive model. */
export async function plainText(
  client: AnthropicLike,
  args: { system: string; user: string; maxTokens?: number },
): Promise<ModelResult<string>> {
  try {
    const res = await client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: args.maxTokens ?? 800,
      output_config: { effort: 'low' },
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
    });
    if (res.stop_reason === 'refusal') return { ok: false, error: 'refusal' };
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    return text ? { ok: true, data: text, model: res.model } : { ok: false, error: 'empty' };
  } catch (e) {
    return { ok: false, error: errorLabel(e) };
  }
}
