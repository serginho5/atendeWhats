// Monitor de desconexão do WhatsApp. Roda dentro do próprio servidor Node
// (iniciado em src/server.ts) e, a cada 5 min, pergunta à Evolution API o
// estado de cada instância marcada como "connected" no banco.
//
// Quando uma instância fica fora do ar em 2 checagens seguidas (~10 min, pra
// não alarmar com quedas de segundos), marca como "disconnected" e manda
// e-mail pro cliente e pros super admins. O aviso sai uma vez por queda: só
// volta a valer depois que o cliente reconecta pelo painel (getWhatsappStatus
// grava "connected" de novo).
//
// Também avisa os super admins se a própria Evolution API parar de responder.

const CHECK_EVERY_MS = 5 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const FAILS_BEFORE_ALERT = 2;
const EVO_DOWN_RUNS_BEFORE_ALERT = 3;

const fails = new Map<string, number>();
let evoDownRuns = 0;
let evoDownAlerted = false;
let running = false;

export function startWhatsappMonitor() {
  const g = globalThis as any;
  if (g.__whatsappMonitorStarted) return;
  g.__whatsappMonitorStarted = true;
  if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) {
    console.warn("[whatsapp-monitor] Evolution API não configurada, monitor desligado");
    return;
  }
  setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void tick(), CHECK_EVERY_MS);
  console.log("[whatsapp-monitor] ligado (checagem a cada 5 min)");
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await checkAll();
  } catch (e: any) {
    console.error("[whatsapp-monitor]", e?.message || e);
  } finally {
    running = false;
  }
}

async function checkAll() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { evoState } = await import("@/lib/evolution.server");

  const { data: rows, error } = await (supabaseAdmin as any)
    .from("whatsapp_instances")
    .select("instance_name, company_id, user_id, numero")
    .eq("status", "connected");
  if (error) throw new Error(error.message);
  if (!rows?.length) return;

  let reachable = 0;
  for (const row of rows as any[]) {
    let state: string | null;
    try {
      const s: any = await evoState(row.instance_name);
      state = s?.instance?.state || s?.state || null;
      reachable++;
    } catch {
      // Erro de rede/Evolution fora: não conta como desconexão do cliente.
      continue;
    }

    if (state === "open") {
      fails.delete(row.instance_name);
      continue;
    }

    const count = (fails.get(row.instance_name) ?? 0) + 1;
    fails.set(row.instance_name, count);
    if (count < FAILS_BEFORE_ALERT) continue;
    fails.delete(row.instance_name);

    // Update condicional: se o painel já marcou como desconectado nesse meio
    // tempo, não volta nada e o aviso não sai em dobro.
    const { data: changed } = await (supabaseAdmin as any)
      .from("whatsapp_instances")
      .update({ status: "disconnected" })
      .eq("instance_name", row.instance_name)
      .eq("status", "connected")
      .select("instance_name");
    if (!changed?.length) continue;

    console.warn(`[whatsapp-monitor] ${row.instance_name} desconectou (estado: ${state ?? "desconhecido"})`);
    await notifyDisconnected(supabaseAdmin, row).catch((e: any) =>
      console.error("[whatsapp-monitor] falha ao avisar desconexão:", e?.message || e),
    );
  }

  if (reachable === 0) {
    evoDownRuns++;
    if (evoDownRuns >= EVO_DOWN_RUNS_BEFORE_ALERT && !evoDownAlerted) {
      evoDownAlerted = true;
      await notifyAdmins(supabaseAdmin, {
        empresa: "Evolution API",
        contatoNome: null,
        contatoEmail: "—",
        detalhe: "A Evolution API não responde há uns 15 minutos. Nenhum WhatsApp de cliente consegue mandar ou receber mensagens. Verifique o container evolution-api no VPS.",
      }).catch(() => {});
    }
  } else {
    evoDownRuns = 0;
    evoDownAlerted = false;
  }
}

async function notifyDisconnected(admin: any, row: { company_id: string; user_id: string; numero: string | null }) {
  const { sendEmail } = await import("@/lib/email/send");
  const { renderWhatsappDisconnectedEmail } = await import("@/lib/email/templates");

  const { data: company } = await admin.from("company").select("nome").eq("id", row.company_id).maybeSingle();
  const { data: userRes } = await admin.auth.admin.getUserById(row.user_id);
  const user = userRes?.user;
  const email: string | null = user?.email ?? null;
  const nome: string | null = user?.user_metadata?.nome || user?.user_metadata?.full_name || null;
  const siteUrl = process.env.SITE_URL || "https://atendemaisempresas.com.br";

  if (email) {
    const { subject, html } = renderWhatsappDisconnectedEmail({ nome, numero: row.numero, conexaoUrl: `${siteUrl}/app/conexao` });
    await sendEmail(email, subject, html).catch((e: any) =>
      console.error("[whatsapp-monitor] falha no e-mail do cliente:", e?.message || e),
    );
  }

  await notifyAdmins(admin, {
    empresa: company?.nome || row.company_id,
    contatoNome: nome,
    contatoEmail: email || "—",
    detalhe: `O WhatsApp${row.numero ? ` ${row.numero}` : ""} desconectou e o agente parou de responder.${email ? " O cliente foi avisado por e-mail." : " Cliente sem e-mail cadastrado, avise manualmente."}`,
  });
}

async function notifyAdmins(admin: any, opts: { empresa: string; contatoNome: string | null; contatoEmail: string; detalhe: string }) {
  const { sendEmail } = await import("@/lib/email/send");
  const { renderInternalAlertEmail } = await import("@/lib/email/templates");
  const { data: cfg } = await admin.from("app_config").select("super_admin_emails").eq("id", true).maybeSingle();
  const { subject, html } = renderInternalAlertEmail({ tipo: "desconexao", ...opts });
  for (const to of (cfg?.super_admin_emails ?? []) as string[]) {
    await sendEmail(to, subject, html).catch(() => {});
  }
}
