/** Minimal OpenAI-compatible streaming client; queueing and tiers live in gateway.ts. */

export type Thinking = 'disabled' | 'low' | 'high' | 'max';

export interface ModelConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  thinking: Thinking;
  timeoutMs: number;
  /** Includes reasoning tokens when thinking is on. */
  maxTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the provider does not report cache hits. */
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

export interface Timing {
  /** Milliseconds from sending the request. */
  firstReasoningMs: number | null;
  firstContentMs: number | null;
  totalMs: number;
}

export interface Completion {
  content: string;
  reasoning: string;
  usage: Usage | null;
  timing: Timing;
  finishReason: string | null;
}

export interface StreamHandlers {
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface ChatOptions {
  /** Turns on the provider's JSON output mode; the prompt must still describe the object. */
  json?: boolean;
  signal?: AbortSignal;
}

/** What callers need from a model: a `ModelClient`, or a gateway lane in front of one. */
export interface ChatModel {
  chat(messages: ChatMessage[], handlers?: StreamHandlers, options?: ChatOptions): Promise<Completion>;
}

const THINKING = new Set<Thinking>(['disabled', 'low', 'high', 'max']);

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const require = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}; copy .env.example to .env and fill it in`);
    return value;
  };
  const thinking = (env.NPC_MODEL_THINKING?.trim() || 'high') as Thinking;
  if (!THINKING.has(thinking)) throw new Error(`NPC_MODEL_THINKING must be one of ${[...THINKING].join(', ')}`);
  const positiveInteger = (key: string, fallback: number) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  return {
    endpoint: require('NPC_MODEL_ENDPOINT').replace(/\/+$/, ''),
    model: require('NPC_MODEL_NAME'),
    apiKey: require('NPC_MODEL_API_KEY'),
    thinking,
    timeoutMs: positiveInteger('NPC_MODEL_TIMEOUT_MS', 60_000),
    maxTokens: positiveInteger('NPC_MODEL_MAX_TOKENS', 4000),
  };
}

export class ModelClient implements ChatModel {
  readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options: ChatOptions = {}): Promise<Completion> {
    const { config } = this;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: config.maxTokens,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        // DeepSeek turns reasoning off with `thinking`; otherwise `reasoning_effort` picks the level.
        ...(config.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : { reasoning_effort: config.thinking }),
      }),
      signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(options.signal ? [options.signal] : [])]),
    };
    const response = await fetchWithReconnect(`${config.endpoint}/chat/completions`, request);
    if (!response.ok || !response.body) {
      throw new Error(`Model request failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
    }

    const result: Completion = {
      content: '', reasoning: '', usage: null, finishReason: null,
      timing: { firstReasoningMs: null, firstContentMs: null, totalMs: 0 },
    };
    for await (const event of serverSentEvents(response.body)) {
      if (event === '[DONE]') break;
      const chunk = JSON.parse(event) as StreamChunk;
      const choice = chunk.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content;
      const content = choice?.delta?.content;
      if (reasoning) {
        result.timing.firstReasoningMs ??= elapsed();
        result.reasoning += reasoning;
        handlers.onReasoning?.(reasoning);
      }
      if (content) {
        result.timing.firstContentMs ??= elapsed();
        result.content += content;
        handlers.onContent?.(content);
      }
      if (choice?.finish_reason) result.finishReason = choice.finish_reason;
      if (chunk.usage) result.usage = usageOf(chunk.usage);
    }
    result.timing.totalMs = elapsed();
    return result;
  }
}

const RECONNECTS = 2;

/** Retries only connection failures that happen before any response, e.g. a TLS reset; never timeouts. */
async function fetchWithReconnect(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const connectionFailed = error instanceof TypeError && error.message === 'fetch failed';
      if (!connectionFailed || attempt >= RECONNECTS || init.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: RawUsage;
}

interface RawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function usageOf(raw: RawUsage): Usage {
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    cachedInputTokens: raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

/** Yields the data payload of each server-sent event. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer = (buffer + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      if (data.length) yield data.join('\n');
    }
  }
}
