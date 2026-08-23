// OpenRouter LLM client (OpenAI-compatible /chat/completions, tool calling).
// Enabled when OPENROUTER_API_KEY is set. Without a key the agent falls back to
// the deterministic rule-based parser (see router.ts) — ТЗ этап 1.

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  model: string;
}

const BASE = "https://openrouter.ai/api/v1";

export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function llmModel(): string {
  return process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
}

export async function llmChat(
  opts: { messages: LLMMessage[]; tools?: LLMTool[]; timeoutMs?: number }
): Promise<LLMResponse> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const model = llmModel();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_URL ?? "http://localhost:3000",
        "X-Title": "Unified AI Ads Agent",
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature: 0.2,
        max_tokens: 600,
        ...(opts.tools?.length ? { tools: opts.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string | null; tool_calls?: LLMToolCall[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? null,
    toolCalls: msg?.tool_calls ?? [],
    model: data.model ?? model,
  };
}
