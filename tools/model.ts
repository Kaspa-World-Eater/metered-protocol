/**
 * A `Deliver` backed by a real language model, so a session meters actual model output.
 *
 * WHY THIS LIVES IN tools/ AND NOT src/. The protocol does not know what it is metering. `Deliver`
 * is a function the caller supplies, and keeping every network-touching adapter out of `src/`
 * keeps the library honest about that: an implementer metering translations or transcription
 * writes their own adapter and changes nothing else.
 *
 * WHY THE UNIT LINES UP EXACTLY. SPEC.md 6.1 counts the assistant content DELIVERED TO THE BUYER,
 * tokenised with the tokeniser the Offer names -- here `o200k_base`, which is the tokeniser
 * gpt-4o-mini's own `completion_tokens` is computed with. evidence/provider_study.py checked that
 * correspondence on 12 live completions and found exact agreement every time, which is why this
 * adapter can hand the raw text straight to both meters and expect them to agree.
 *
 * THE BABEL IS ENFORCED AT THE MODEL. `max_completion_tokens` is set to the reserved babel, so the
 * model physically cannot deliver more than was authorised. That is the exposure bound arriving
 * as an API parameter rather than as a hope.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_FILE = join(homedir(), '.metered', 'providers.env');
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export const DEFAULT_MODEL = 'gpt-4o-mini';

/** The key, from outside the repository. Returns null rather than throwing, so callers can skip. */
export function loadProviderKey(): string | null {
  if (!existsSync(KEY_FILE)) return null;
  const match = readFileSync(KEY_FILE, 'utf8').match(/^OPENAI_API_KEY=(\S+)\s*$/m);
  return match?.[1] ?? null;
}

export interface ModelReply {
  content: string;
  /** What the provider says it produced. Compared against the meters, never trusted instead. */
  reportedTokens: number;
}

/** One completion, capped at `maxUnits` output tokens. */
export async function complete(
  apiKey: string,
  prompt: string,
  maxUnits: number,
  model = DEFAULT_MODEL,
): Promise<ModelReply> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: maxUnits,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`model call failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as {
    choices: { message: { content: string | null } }[];
    usage: { completion_tokens: number };
  };
  return {
    content: body.choices[0]?.message.content ?? '',
    reportedTokens: body.usage.completion_tokens,
  };
}

/**
 * A synchronous `Deliver` over an asynchronous model.
 *
 * `Deliver` is synchronous because reconciliation is, so the model is called ahead of time and the
 * replies are handed out in order. A real provider would make `Deliver` async; the demo keeps the
 * protocol's own shape unchanged rather than reworking it to accommodate one adapter.
 */
export function prefetched(replies: ModelReply[]): (prompt: string, maxUnits: number) => Uint8Array {
  let i = 0;
  return (prompt: string, maxUnits: number) => {
    void prompt;
    void maxUnits;
    const reply = replies[i];
    i += 1;
    if (!reply) throw new Error('the demo asked for more babels than were prefetched');
    return new TextEncoder().encode(reply.content);
  };
}

/** The prompts the demo meters. Short, so a babel of a few dozen tokens is a whole answer. */
const DEMO_PROMPTS = [
  'In two sentences, explain what a metered payment protocol is.',
  'In two sentences, why is settlement cost the limit on micropayments?',
  'In two sentences, what is a blockDAG?',
];

export interface ModelSource {
  deliver: (prompt: string, maxUnits: number) => Uint8Array;
  reportedTokens: number[];
  model: string;
}

/**
 * Fetch the demo's completions up front, or return null when no model was asked for.
 *
 * Throws rather than falling back when `--model` was asked for and no key is present: silently
 * metering generated text while the operator believes a model is behind it would make the one
 * claim the demo exists to support into the one thing it faked.
 */
export async function demoModel(wanted: boolean, maxUnits: number): Promise<ModelSource | null> {
  if (!wanted) return null;
  const apiKey = loadProviderKey();
  if (!apiKey) throw new Error('--model needs OPENAI_API_KEY in ~/.metered/providers.env');

  const replies: ModelReply[] = [];
  for (const prompt of DEMO_PROMPTS) replies.push(await complete(apiKey, prompt, maxUnits));
  return {
    deliver: prefetched(replies),
    reportedTokens: replies.map((r) => r.reportedTokens),
    model: DEFAULT_MODEL,
  };
}
