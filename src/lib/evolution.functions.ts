import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getRequest } from "@tanstack/react-start/server";

function deriveInstanceName(companyId: string) {
  return `atendezap_${companyId.replace(/-/g, "").slice(0, 16)}`;
}

function buildWebhookUrl(token?: string | null) {
  try {
    const req = getRequest();
    const url = new URL(req.url);
    const tokenQuery = token ? `?t=${encodeURIComponent(token)}` : "";
    return `${url.protocol}//${url.host}/api/public/whatsapp-webhook${tokenQuery}`;
  } catch {
    return "";
  }
}

async function resolveCompanyId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("company_user")
    .select("company_id")
    .eq("user_id", userId)
    .eq("ativo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Você ainda não possui uma empresa. Finalize o onboarding.");
  return data.company_id as string;
}

// Normaliza o número pra conexão por código: só dígitos, com DDI 55 se vier só DDD+número.
function normalizePairingNumber(raw?: string | null): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  if (full.length < 12 || full.length > 13) {
    throw new Error("Número inválido. Use DDD + número, ex.: (11) 91234-5678.");
  }
  return full;
}

// Sem `numero`: conecta por QR Code. Com `numero`: pede à Evolution o código de
// 8 dígitos (WhatsApp → Aparelhos conectados → Conectar com número de telefone).
export const connectWhatsapp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d?: { numero?: string | null }) => d ?? {})
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const pairingNumber = normalizePairingNumber(data?.numero);
    const {
      evoCreateInstance,
      evoGetQr,
      evoParseQr,
      evoSetWebhook,
      evoState,
      evoLogout,
      evoDelete,
    } = await import("./evolution.server");

    const { data: existing } = await (supabase as any)
      .from("whatsapp_instances")
      .select("instance_name,status,numero,webhook_token")
      .eq("company_id", companyId)
      .maybeSingle();
    const instanceName = existing?.instance_name || deriveInstanceName(companyId);
    const webhookToken = existing?.webhook_token || crypto.randomUUID();
    const webhookUrl = buildWebhookUrl(webhookToken);
    // Só pode derrubar/recriar a instância (fallback de QR abaixo) se tivermos
    // confirmado com a Evolution que a sessão NÃO está aberta.
    let confirmedNotOpen = !existing?.instance_name;
    if (existing?.instance_name) {
      try {
        const s = await evoState(existing.instance_name);
        const existingState = s?.instance?.state || (s as any)?.state;
        if (existingState && existingState !== "open") confirmedNotOpen = true;
        if (existingState === "open") {
          if (webhookUrl) {
            try { await evoSetWebhook(existing.instance_name, webhookUrl); } catch (e) { console.warn("[evolution.setWebhook]", e); }
          }
          if (existing.status !== "connected") {
            await supabase
              .from("whatsapp_instances")
              .update({ status: "connected", webhook_token: webhookToken, webhook_configured_at: new Date().toISOString() } as any)
              .eq("company_id", companyId);
          }
          return { instanceName: existing.instance_name, qrBase64: null, code: null, pairingCode: null, state: "open", webhookUrl };
        }
      } catch {}
    }

    const { error: upsertErr } = await supabase
      .from("whatsapp_instances")
      .upsert(
        { company_id: companyId, user_id: userId, instance_name: instanceName, status: "connecting", webhook_token: webhookToken } as any,
        { onConflict: "company_id" },
      );
    if (upsertErr) throw upsertErr;

    try {
      await evoCreateInstance(instanceName, webhookUrl, pairingNumber ?? undefined);
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (!/exists|already/i.test(msg)) console.warn("[evolution.create]", msg);
      if (!/exists|already/i.test(msg)) throw e;
    }

    if (webhookUrl) {
      try { await evoSetWebhook(instanceName, webhookUrl); } catch (e) { console.warn("[evolution.setWebhook]", e); }
    }

    let qrBase64: string | null = null;
    let code: string | null = null;
    let pairingCode: string | null = null;
    let lastQrError: unknown = null;
    // No modo código, só serve o pairingCode; no modo QR, QR ou código bruto.
    const gotIt = () => (pairingNumber ? !!pairingCode : !!(qrBase64 || code));
    async function pollQr(tries: number) {
      for (let i = 0; i < tries; i++) {
        try {
          const qr = await evoGetQr(instanceName, pairingNumber ?? undefined);
          qrBase64 = qr.qrBase64;
          code = qr.code;
          pairingCode = qr.pairingCode;
          if (gotIt()) return;
        } catch (e) { lastQrError = e; console.warn("[evolution.connect]", e); }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    await pollQr(6);

    // Instância que levou LOGOUT do WhatsApp pode ficar presa em "connecting"
    // sem nunca gerar QR novo. Aqui a sessão já não está "open" (checado acima),
    // então é seguro derrubar: primeiro logout, e se ainda não vier QR, recria.
    if (!gotIt() && confirmedNotOpen) {
      console.warn(`[evolution.connect] ${instanceName} sem QR, tentando logout`);
      try { await evoLogout(instanceName); } catch {}
      await pollQr(4);
    }
    if (!gotIt() && confirmedNotOpen) {
      console.warn(`[evolution.connect] ${instanceName} ainda sem QR, recriando instância`);
      try { await evoDelete(instanceName); } catch (e) { console.warn("[evolution.delete]", e); }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const created = await evoCreateInstance(instanceName, webhookUrl, pairingNumber ?? undefined);
        const qr = await evoParseQr(created);
        qrBase64 = qr.qrBase64;
        code = qr.code;
        pairingCode = qr.pairingCode;
      } catch (e) { lastQrError = e; console.warn("[evolution.recreate]", e); }
      if (webhookUrl) {
        try { await evoSetWebhook(instanceName, webhookUrl); } catch (e) { console.warn("[evolution.setWebhook]", e); }
      }
      if (!gotIt()) await pollQr(6);
    }

    if (!gotIt() && lastQrError) {
      throw lastQrError;
    }
    if (pairingNumber && !pairingCode) {
      throw new Error("O WhatsApp não gerou o código agora. Aguarde alguns minutos e tente de novo, ou use o QR Code.");
    }

    let state: string | undefined;
    try {
      const s = await evoState(instanceName);
      state = s?.instance?.state || (s as any)?.state;
    } catch {}

    return { instanceName, qrBase64, code, pairingCode, state, webhookUrl };
  });

export const checkWhatsappStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const { evoState, evoFetchNumberFromInstance, evoSetWebhook } = await import("./evolution.server");

    const { data: row } = await (supabase as any)
      .from("whatsapp_instances")
      .select("instance_name,status,numero,webhook_token,webhook_configured_at")
      .eq("company_id", companyId)
      .maybeSingle();
    if (!row) return { status: "disconnected", state: null, numero: null, qrBase64: null, code: null };

    let state: string | null = null;
    let stateError = false;
    try {
      const s = await evoState(row.instance_name);
      state = s?.instance?.state || (s as any)?.state || null;
    } catch (e) {
      stateError = true;
      console.warn("[evolution.state]", e);
    }

    // IMPORTANTE: NUNCA chamar evoGetQr aqui. Chamar /instance/connect em sessão
    // ativa DERRUBA a sessão do WhatsApp pra gerar um QR novo. QR só é buscado
    // explicitamente em connectWhatsapp (botão "Conectar"). Em erro transitório,
    // preservar o último status conhecido pra não causar "flicker" de desconexão.
    if (stateError) {
      return {
        status: row.status || "disconnected",
        state: null,
        numero: row.numero ?? null,
        qrBase64: null,
        code: null,
      };
    }

    const newStatus =
      state === "open" ? "connected" : state === "connecting" ? "connecting" : "disconnected";

    let numero: string | null = row.numero ?? null;
    if (newStatus === "connected" && !numero) {
      try { numero = await evoFetchNumberFromInstance(row.instance_name); } catch {}
    }
    if (newStatus === "connected" && row.webhook_token && !row.webhook_configured_at) {
      const webhookUrl = buildWebhookUrl(row.webhook_token);
      if (webhookUrl) {
        try {
          await evoSetWebhook(row.instance_name, webhookUrl);
          await supabase.from("whatsapp_instances").update({ webhook_configured_at: new Date().toISOString() } as any).eq("company_id", companyId);
        } catch (e) { console.warn("[evolution.setWebhook]", e); }
      }
    }

    if (newStatus !== row.status || (numero && numero !== row.numero)) {
      await supabase
        .from("whatsapp_instances")
        .update({ status: newStatus, ...(numero ? { numero } : {}) })
        .eq("company_id", companyId);
    }

    return { status: newStatus, state, numero, qrBase64: null, code: null };
  });

export const disconnectWhatsapp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const { evoLogout } = await import("./evolution.server");
    const { data: row } = await supabase
      .from("whatsapp_instances")
      .select("instance_name")
      .eq("company_id", companyId)
      .maybeSingle();
    if (row) {
      try { await evoLogout(row.instance_name); } catch (e) { console.warn("[evolution.logout]", e); }
      await supabase
        .from("whatsapp_instances")
        .update({ status: "disconnected" })
        .eq("company_id", companyId);
    }
    return { ok: true };
  });

export const sendWhatsappText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { numero: string; texto: string; contatoNome?: string | null }) => d)
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const { data: inst } = await supabase
      .from("whatsapp_instances").select("instance_name,status").eq("company_id", companyId).maybeSingle();
    if (!inst?.instance_name) throw new Error("WhatsApp não conectado");
    const { data: recentInbound } = await supabase
      .from("mensagens")
      .select("id")
      .eq("company_id", companyId)
      .eq("numero", data.numero)
      .eq("direcao", "entrada")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .limit(1);
    if (!recentInbound?.length) {
      throw new Error("Por segurança, só é possível responder contatos que mandaram mensagem nas últimas 24h. Para iniciar conversa, use a API oficial com template aprovado.");
    }
    const { data: recentOutbound } = await supabase
      .from("mensagens")
      .select("id")
      .eq("company_id", companyId)
      .eq("numero", data.numero)
      .eq("direcao", "saida")
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
      .limit(6);
    if ((recentOutbound?.length ?? 0) >= 6) {
      throw new Error("Envio pausado por alguns minutos para proteger a qualidade do número.");
    }
    const { assertWithinLimit } = await import("./plan-limits.server");
    await assertWithinLimit(companyId, "mensagens");
    const { evoSendText } = await import("./evolution.server");
    try { await evoSendText(inst.instance_name, data.numero, data.texto); }
    catch (e: any) { throw new Error(`Falha ao enviar: ${e?.message ?? e}`); }
    const { error } = await supabase.from("mensagens").insert({
      company_id: companyId, user_id: userId, numero: data.numero,
      contato_nome: data.contatoNome ?? null,
      direcao: "saida", autor: "humano", texto: data.texto,
    });
    if (error) throw new Error(error.message);
    // Pause IA on this contact (humano assumed)
    await supabase.from("contact_pause").upsert(
      { company_id: companyId, user_id: userId, numero: data.numero, pausado: true },
      { onConflict: "company_id,numero" },
    );
    return { ok: true };
  });

export const setContactIaActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { numero: string; ativa: boolean }) => d)
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const { error } = await supabase.from("contact_pause").upsert(
      { company_id: companyId, user_id: userId, numero: data.numero, pausado: !data.ativa },
      { onConflict: "company_id,numero" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testAiReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { message: string }) => d)
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const companyId = await resolveCompanyId(supabase, userId);
    const { lovableAiChat } = await import("./lovable-ai.server");
    const { buildSystemPrompt, parseAiOutput } = await import("./ai-prompt");
    const [{ data: cfg }, { data: stagesRows }, { data: prodRows }] = await Promise.all([
      supabase.from("agent_config").select("*").eq("company_id", companyId).maybeSingle(),
      supabase.from("crm_stage").select("nome, tipo, ordem").eq("company_id", companyId).order("ordem", { ascending: true }),
      supabase.from("produto").select("nome, preco, descricao, ordem").eq("company_id", companyId).eq("ativo", true).order("ordem", { ascending: true }),
    ]);
    const stages = (stagesRows ?? []).map((s: any) => ({ nome: s.nome, tipo: s.tipo }));
    const produtos = (prodRows ?? []).map((p: any) => ({ nome: p.nome, preco: p.preco, descricao: p.descricao }));
    const system = buildSystemPrompt(cfg ?? {}, {
      responderEmPartes: cfg?.responder_em_partes ?? true,
      stages,
      produtos,
    });

    // Enforcement: provider precisa estar liberado no plano (Starter = Gemini)
    const { getCompanyPlan } = await import("./plan-limits.server");
    const { allowsProvider, PLAN_LABEL } = await import("./plan-features");
    const plan = await getCompanyPlan(companyId);
    let provider = ((cfg as any)?.ai_provider || "gemini") as string;
    let model = ((cfg as any)?.ai_model || "google/gemini-flash-lite-latest") as string;
    if (!allowsProvider(plan.slug, provider)) {
      throw new Error(
        `O provedor ${provider.toUpperCase()} não está incluso no plano ${PLAN_LABEL[plan.slug]}. Faça upgrade para Pro para usar GPT/Claude.`,
      );
    }

    const raw = await lovableAiChat(
      [
        { role: "system", content: system },
        { role: "user", content: data.message },
      ],
      {
        provider,
        model,
        openaiKey: (cfg as any)?.openai_api_key || "",
        anthropicKey: (cfg as any)?.anthropic_api_key || "",
      },
    );
    const { parts, stage } = parseAiOutput(raw, stages);
    return { reply: parts.join("\n\n"), parts, stage, system };
  });

