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
//
// Troca de número (11/11): em cada instância aberta, compara o número REAL da sessão
// (ownerJid na Evolution) com o gravado no banco. Se mudou, atualiza o banco e avisa os
// super admins; se o mesmo número estiver em duas instâncias, avisa também (foi o que
// derrubou a Sofia: o chip da Katia entrou na instância da AW3S).

const CHECK_EVERY_MS = 5 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const FAILS_BEFORE_ALERT = 2;
const EVO_DOWN_RUNS_BEFORE_ALERT = 3;

const fails = new Map<string, number>();
let evoDownRuns = 0;
let evoDownAlerted = false;
const duplicadosAvisados = new Set<string>();
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
  const reais = new Map<string, string[]>(); // número real → instâncias
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
      const real = await checkNumero(supabaseAdmin, row).catch(() => null);
      if (real) reais.set(real, [...(reais.get(real) ?? []), row.instance_name]);
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

  for (const [numero, instancias] of reais) {
    if (instancias.length < 2) continue;
    const chave = `${numero}|${instancias.slice().sort().join(",")}`;
    if (duplicadosAvisados.has(chave)) continue;
    duplicadosAvisados.add(chave);
    const { data: comps } = await (supabaseAdmin as any)
      .from("whatsapp_instances").select("instance_name, company:company(nome)").in("instance_name", instancias);
    const nomes = (comps ?? []).map((c: any) => c.company?.nome || c.instance_name).join(" e ");
    console.warn(`[whatsapp-monitor] número ${numero} conectado em ${instancias.length} instâncias: ${instancias.join(", ")}`);
    await notifyAdmins(supabaseAdmin, {
      tipo: "numero_trocado",
      empresa: nomes,
      contatoNome: null,
      contatoEmail: "—",
      detalhe: `O mesmo WhatsApp (+${numero}) está conectado em ${instancias.length} empresas ao mesmo tempo: ${nomes}. Uma delas está recebendo as mensagens da outra, e o WhatsApp vai derrubar uma das sessões. Confira a Conexão de cada empresa e reconecte o número certo.`,
    }).catch(() => {});
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

// Número real da sessão x número no banco. Devolve o número real (só dígitos) ou null.
async function checkNumero(admin: any, row: { instance_name: string; company_id: string; numero: string | null }): Promise<string | null> {
  const { evoFetchNumberFromInstance } = await import("@/lib/evolution.server");
  const { mesmoTelefone } = await import("@/lib/handoff.server");
  const real = await evoFetchNumberFromInstance(row.instance_name);
  if (!real) return null;
  if (!row.numero) {
    // Primeira leitura (ex.: conectou por QR e o número ficou vazio): só grava, sem alarme.
    await admin.from("whatsapp_instances").update({ numero: real }).eq("instance_name", row.instance_name);
    return real;
  }
  if (mesmoTelefone(real, row.numero)) return real;

  // Trocou: grava o novo (o aviso sai uma vez só) e avisa os super admins.
  await admin.from("whatsapp_instances").update({ numero: real }).eq("instance_name", row.instance_name);
  const { data: company } = await admin.from("company").select("nome").eq("id", row.company_id).maybeSingle();
  console.warn(`[whatsapp-monitor] ${row.instance_name}: número trocou de ${row.numero} para ${real}`);
  await notifyAdmins(admin, {
    tipo: "numero_trocado",
    empresa: company?.nome || row.company_id,
    contatoNome: null,
    contatoEmail: "—",
    detalhe: `O WhatsApp conectado nesta empresa trocou de +${row.numero} para +${real}. Se não foi de propósito, outro celular leu o QR Code desta empresa: as mensagens dos clientes estão chegando no número errado. Confira em Conexão.`,
  }).catch(() => {});
  return real;
}

async function notifyAdmins(admin: any, opts: { tipo?: "desconexao" | "numero_trocado"; empresa: string; contatoNome: string | null; contatoEmail: string; detalhe: string }) {
  const { sendEmail } = await import("@/lib/email/send");
  const { renderInternalAlertEmail } = await import("@/lib/email/templates");
  const { data: cfg } = await admin.from("app_config").select("super_admin_emails").eq("id", true).maybeSingle();
  const { subject, html } = renderInternalAlertEmail({ ...opts, tipo: opts.tipo ?? "desconexao" });
  for (const to of (cfg?.super_admin_emails ?? []) as string[]) {
    await sendEmail(to, subject, html).catch(() => {});
  }
}
