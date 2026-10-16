// Multi-provider AI chat. Gemini default via Google AI Studio (chave própria do backend).
// OpenAI e Anthropic usam a chave da própria empresa.
import { fetchWithTimeout } from "./fetch-with-timeout";

const AI_TIMEOUT_MS = 30000;

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

// Transcreve áudio de WhatsApp usando a chave própria da plataforma (Gemini),
// independente do provedor de IA que a empresa configurou para as respostas —
// assim funciona pra qualquer empresa sem precisar de chave extra.
export async function transcribeAudio(base64: string, mimetype: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY ausente. Gere uma chave grátis em aistudio.google.com/apikey.");
  const cleanMime = (mimetype || "audio/ogg").split(";")[0].trim();
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Transcreva este áudio em português do Brasil. Responda APENAS com o texto transcrito, sem comentários e sem aspas." },
              { inline_data: { mime_type: cleanMime, data: base64 } },
            ],
          },
        ],
      }),
    },
    AI_TIMEOUT_MS,
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini (transcrição): ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || "")
    .join("")
    .trim();
  return text;
}

// O Gemini às vezes responde 503 ("high demand") ou fica muito lento. Em vez de
// deixar o cliente sem resposta, tenta o próximo modelo da lista. Cada tentativa
// tem um teto curto, pra soma não passar muito do AI_TIMEOUT_MS.
const GEMINI_FALLBACKS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const GEMINI_ATTEMPT_TIMEOUT_MS = 12000;

async function geminiChat(key: string, model: string, messages: ChatMsg[]): Promise<string> {
  const first = model.replace(/^google\//, "");
  const chain = [first, ...GEMINI_FALLBACKS.filter((m) => m !== first)];
  const startedAt = Date.now();
  let lastErr: unknown = null;
  for (const modelId of chain) {
    const remaining = AI_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining < 2000) break;
    try {
      return await geminiChatOnce(key, modelId, messages, Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, remaining));
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || "");
      // Só troca de modelo em erro de capacidade/tempo; erro de requisição não melhora trocando.
      if (!/ 50[0-9]|429|Limite|timeout|abort|indispon|Tempo esgotado/i.test(msg)) throw e;
      console.warn(`[ai] ${modelId} falhou (${msg.slice(0, 80)}), tentando o próximo`);
    }
  }
  throw lastErr ?? new Error("Gemini indisponível");
}

async function geminiChatOnce(key: string, modelId: string, messages: ChatMsg[], timeoutMs: number): Promise<string> {
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body: Record<string, unknown> = { contents };
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };

  const res = await fetchWithTimeout(
    // Chave no header (não na URL), pra não vazar em mensagem de erro/log.
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) },
    timeoutMs,
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
  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
  }, AI_TIMEOUT_MS);
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
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages: conv }),
  }, AI_TIMEOUT_MS);
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
