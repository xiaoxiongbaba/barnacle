import Anthropic from "@anthropic-ai/sdk";

/**
 * Two wire formats cover almost every provider:
 * - "anthropic": the Anthropic Messages API, through the official SDK
 * - "openai": any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, DeepSeek,
 *   Gemini's OpenAI endpoint, Ollama, LM Studio, vLLM, …)
 */
export type ProviderKind = "anthropic" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  maxTokens: number | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Tokens one call used. `estimated` when the provider didn't say (counted from the text). */
export interface Usage {
  input: number;
  output: number;
  estimated: boolean;
}

/** Who a model call is for, so its cost is booked to them. */
export interface UsageTag {
  occupantId: string | null;
  taskId?: number | null;
  kind: "task" | "chat" | "report" | "ceo" | "planner" | "summary";
}

let usageListener: ((model: string, tag: UsageTag, usage: Usage) => void) | null = null;

/** Every model call's token use goes here (the cost ledger). */
export function onUsage(listener: (model: string, tag: UsageTag, usage: Usage) => void) {
  usageListener = listener;
}

function book(req: { model: string; tag?: UsageTag }, usage: Usage) {
  if (usage.input || usage.output) usageListener?.(req.model, req.tag ?? { occupantId: null, kind: "chat" }, usage);
}

/** About 4 characters a token for Latin text, ~1.5 for CJK: only when the provider reports nothing. */
export function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) ?? []).length;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

export interface ChatRequest {
  model: string;
  /** Who the cost is booked to. */
  tag?: UsageTag;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal: AbortSignal;
  onText: (text: string) => void;
}

/** Errors meant for the person configuring the provider: short, no stack, never contain the key. */
export class ProviderError extends Error {}

const OPENAI_DEFAULT = "https://api.openai.com/v1";
const trimSlash = (url: string) => url.replace(/\/+$/, "");

function anthropicClient(p: ProviderConfig) {
  if (!p.apiKey) throw new ProviderError("This provider needs an API key.");
  return new Anthropic({ apiKey: p.apiKey, ...(p.baseUrl ? { baseURL: trimSlash(p.baseUrl) } : {}), maxRetries: 1 });
}

function describe(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError("The API key was rejected (401).");
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError("This key may not use that model (403).");
  if (error instanceof Anthropic.NotFoundError) return new ProviderError("Model or endpoint not found (404).");
  if (error instanceof Anthropic.RateLimitError) return new ProviderError("Rate limited by the provider (429); try again later.");
  if (error instanceof Anthropic.BadRequestError) return new ProviderError(`The provider rejected the request: ${error.message}`);
  if (error instanceof Anthropic.APIError) return new ProviderError(`Provider error ${error.status ?? ""}: ${error.message}`.trim());
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("The request timed out.");
  if (error instanceof Error) return new ProviderError(`Could not reach the provider: ${error.message}`);
  return new ProviderError("Unknown provider error.");
}

async function openaiFetch(p: ProviderConfig, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${trimSlash(p.baseUrl ?? OPENAI_DEFAULT)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } | string };
      detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
    } catch {
      // Not JSON; the status code is enough.
    }
    const hint = res.status === 401 ? "The API key was rejected" : res.status === 404 ? "Model or endpoint not found" : "Provider error";
    throw new ProviderError(`${hint} (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
  }
  return res;
}

export async function listModels(p: ProviderConfig): Promise<ModelInfo[]> {
  try {
    if (p.kind === "anthropic") {
      const models: ModelInfo[] = [];
      for await (const m of anthropicClient(p).models.list()) {
        models.push({ id: m.id, name: m.display_name, maxTokens: (m as { max_tokens?: number }).max_tokens ?? null });
      }
      return models;
    }
    const res = await openaiFetch(p, "/models", { method: "GET", signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.id, maxTokens: null })).sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    throw describe(error);
  }
}

/** Streams a reply. Resolves with the full text; refusals and errors become ProviderError. */
export async function chat(p: ProviderConfig, req: ChatRequest): Promise<string> {
  try {
    return p.kind === "anthropic" ? await chatAnthropic(p, req) : await chatOpenAI(p, req);
  } catch (error) {
    throw describe(error);
  }
}

async function chatAnthropic(p: ProviderConfig, req: ChatRequest): Promise<string> {
  // No temperature or thinking settings: newer Claude models reject the former and choose thinking adaptively.
  const stream = anthropicClient(p).messages.stream(
    { model: req.model, max_tokens: req.maxTokens, system: req.system || undefined, messages: req.messages },
    { signal: req.signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      req.onText(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  const u = final.usage;
  book(req, { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens, estimated: false });
  if (final.stop_reason === "refusal") throw new ProviderError("The model declined to answer this message.");
  return text;
}

async function chatOpenAI(p: ProviderConfig, req: ChatRequest): Promise<string> {
  const res = await openaiFetch(p, "/chat/completions", {
    method: "POST",
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: req.maxTokens,
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
      // OpenAI itself only reports usage when asked; others report it anyway or ignore this.
      ...(p.baseUrl ? {} : { stream_options: { include_usage: true } }),
    }),
  });
  if (!res.body) throw new ProviderError("The provider returned an empty response.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage | null = null;
  const done = () => {
    book(req, usage ?? { input: estimateTokens(req.system + req.messages.map((m) => m.content).join("\n")), output: estimateTokens(text), estimated: true });
    return text;
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return done();
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: OpenAIUsage | null };
        if (chunk.usage?.prompt_tokens !== undefined) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens ?? 0, estimated: false };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          req.onText(delta);
        }
      } catch {
        // Keep-alive comments or partial vendor extensions; skip.
      }
    }
  }
  return done();
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// ---------------------------------------------------------------- agents with tools

/** A tool an agent may call while working on a task. `run` returns text for the model. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentRequest {
  model: string;
  /** Who the cost is booked to. */
  tag?: UsageTag;
  system: string;
  prompt: string;
  /** Images sent with the prompt (base64), for models that can see. */
  images?: { mime: string; data: string }[];
  maxTokens: number;
  tools: AgentTool[];
  /** Tool rounds before the agent is asked to wrap up. */
  maxSteps: number;
  signal: AbortSignal;
  /** Sent with the tool results two rounds before the end (e.g. "save what's worth remembering now"). */
  nearEnd?: string;
  /** Called before each tool runs (to show progress). */
  onTool: (name: string, input: Record<string, unknown>) => void;
}

/**
 * Runs the tool loop until the model answers without calling a tool; resolves with that final answer.
 * After `maxSteps` rounds the model is asked to finish with what it has.
 */
export async function runAgent(p: ProviderConfig, req: AgentRequest): Promise<string> {
  try {
    return p.kind === "anthropic" ? await agentAnthropic(p, req) : await agentOpenAI(p, req);
  } catch (error) {
    throw describe(error);
  }
}

async function runTool(req: AgentRequest, name: string, input: Record<string, unknown>): Promise<string> {
  const tool = req.tools.find((t) => t.name === name);
  if (!tool) return `Error: there is no tool called ${name}.`;
  req.onTool(name, input);
  try {
    return await tool.run(input);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return `Error: ${(error as Error).message}`;
  }
}

const WRAP_UP = "You have used all your tool calls. Finish now: give your best final answer with what you have.";

async function agentAnthropic(p: ProviderConfig, req: AgentRequest): Promise<string> {
  const client = anthropicClient(p);
  const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema }));
  const images = (req.images ?? []).map(
    (i): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: i.mime as "image/png", data: i.data } }),
  );
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: images.length ? [...images, { type: "text", text: req.prompt }] : req.prompt }];
  for (let step = 0; ; step++) {
    const last = step >= req.maxSteps;
    const res = await client.messages.create(
      { model: req.model, max_tokens: req.maxTokens, system: req.system || undefined, tools, tool_choice: last ? { type: "none" } : { type: "auto" }, messages },
      { signal: req.signal },
    );
    book(req, { input: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), output: res.usage.output_tokens, estimated: false });
    if (res.stop_reason === "refusal") throw new ProviderError("The model declined this task.");
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!calls.length || last) return text;
    messages.push({ role: "assistant", content: res.content });
    const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
    for (const call of calls) {
      results.push({ type: "tool_result", tool_use_id: call.id, content: await runTool(req, call.name, (call.input ?? {}) as Record<string, unknown>) });
    }
    // Notes ride along with these results: a heads-up two rounds before the end, then the wrap-up.
    if (req.nearEnd && step + 3 === req.maxSteps) results.push({ type: "text", text: req.nearEnd });
    if (step + 1 >= req.maxSteps) results.push({ type: "text", text: WRAP_UP });
    messages.push({ role: "user", content: results });
  }
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function agentOpenAI(p: ProviderConfig, req: AgentRequest): Promise<string> {
  const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const content = req.images?.length
    ? [{ type: "text", text: req.prompt }, ...req.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))]
    : req.prompt;
  const messages: Record<string, unknown>[] = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content }];
  for (let step = 0; ; step++) {
    const last = step >= req.maxSteps;
    if (last) messages.push({ role: "user", content: WRAP_UP });
    const res = await openaiFetch(p, "/chat/completions", {
      method: "POST",
      signal: req.signal,
      body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, messages, ...(last ? {} : { tools, tool_choice: "auto" }) }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[]; usage?: OpenAIUsage };
    const message = body.choices?.[0]?.message;
    if (!message) throw new ProviderError("The provider returned an empty response.");
    book(
      req,
      body.usage?.prompt_tokens !== undefined
        ? { input: body.usage.prompt_tokens, output: body.usage.completion_tokens ?? 0, estimated: false }
        : {
            input: estimateTokens(JSON.stringify(messages).replace(/data:image[^"]+/g, "")) + estimateTokens(JSON.stringify(tools)) + 1000 * (req.images?.length ?? 0),
            output: estimateTokens((message.content ?? "") + JSON.stringify(message.tool_calls ?? [])),
            estimated: true,
          },
    );
    const calls = message.tool_calls ?? [];
    if (!calls.length || last) return (message.content ?? "").trim();
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // Bad JSON from the model: run with no input and let the tool say what's missing.
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(req, call.function.name, input) });
    }
    if (req.nearEnd && step + 3 === req.maxSteps) messages.push({ role: "user", content: req.nearEnd });
  }
}
