// Multi-provider AI chat. Gemini default via Google AI Studio (chave própria do backend).
// OpenAI e Anthropic usam a chave da própria empresa.

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiProviderConfig {
  provider?: "gemini" | "openai" | "anthropic" | string;
  model?: string;
  openaiKey?: string;
  anthropicKey?: string;
}

export async function lovableAiChat(
  messages: ChatMsg[],
  modelOrConfig: string | AiProviderConfig = "google/gemini-flash-lite-latest",
): Promise<string> {
  const cfg: AiProviderConfig =
    typeof modelOrConfig === "string"
      ? { provider: "gemini", model: modelOrConfig }
      : modelOrConfig;
  const provider = (cfg.provider || "gemini").toLowerCase();

  if (provider === "openai") {
    const key = cfg.openaiKey?.trim();
    if (!key) throw new Error("Chave OpenAI não configurada na sua empresa.");
    const model = cfg.model || "gpt-4o-mini";
    return openAiChat(key, model, messages);
  }
  if (provider === "anthropic") {
    const key = cfg.anthropicKey?.trim();
    if (!key) throw new Error("Chave Anthropic (Claude) não configurada na sua empresa.");
    const model = cfg.model || "claude-3-5-sonnet-latest";
    return anthropicChat(key, model, messages);
  }
  // default: Gemini via Google AI Studio (direto)
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY ausente. Gere uma chave grátis em aistudio.google.com/apikey.");
  const model = cfg.model || "google/gemini-flash-lite-latest";
  return geminiChat(key, model, messages);
}

async function geminiChat(key: string, model: string, messages: ChatMsg[]): Promise<string> {
  const modelId = model.replace(/^google\//, "");
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body: Record<string, unknown> = { contents };
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 429) throw new Error("Limite de uso do Gemini atingido. Tente em alguns minutos.");
    throw new Error(`Gemini: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || "")
    .join("")
    .trim();
  return text;
}

async function openAiChat(key: string, model: string, messages: ChatMsg[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.toString().trim() || "";
}

async function anthropicChat(key: string, model: string, messages: ChatMsg[]): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conv = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages: conv }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const txt = (data?.content || [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n")
    .trim();
  return txt;
}
