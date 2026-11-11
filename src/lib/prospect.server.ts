// SERVER ONLY. Primeiro contato de prospecção vindo de fora (ex.: máquina de vendas da AW3S):
// POST /api/public/v1?resource=prospect  (Bearer azp_… da empresa/chip que vai enviar)
//
// body: {
//   numero: "5515999999999",
//   texto: "mensagem da isca",
//   imagens?: [{ base64, mimetype?, nome? }],   // até 3, enviadas antes do texto
//   contato_nome?: "Della Belle Estética",
//   ref_externa?: "slug-do-lead",
//   forcar?: false                              // true = envia mesmo se já houver conversa
// }
//
// Grava tudo em `mensagens` (autor "prospeccao"), para o agente da empresa (ex.: Katia) ver a isca
// no histórico quando o cliente responder. Travas: contato pausado/opt-out, conversa já existente,
// limite diário por empresa e intervalo mínimo entre envios.

const LIMITE_DIA_PADRAO = 30;       // teto de segurança no servidor (a máquina controla o aquecimento)
const INTERVALO_MIN_MS = 60_000;    // pelo menos 1 min entre dois primeiros contatos da mesma empresa
const MAX_IMAGEM_BYTES = 2_500_000; // ~2,5 MB por imagem

type Imagem = { base64: string; mimetype?: string; nome?: string };

export class ProspectError extends Error {
  constructor(message: string, public status = 400, public code = "erro") { super(message); }
}

function inicioDoDiaSP(): string {
  // Meia-noite em São Paulo (UTC-3), em ISO UTC
  const agora = new Date();
  const sp = new Date(agora.getTime() - 3 * 3600_000);
  const meiaNoiteSP = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()) + 3 * 3600_000;
  return new Date(meiaNoiteSP).toISOString();
}

export async function enviarProspeccao(companyId: string, userId: string, body: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const numero = String(body?.numero || "").replace(/\D/g, "");
  const texto = String(body?.texto || "").trim();
  const imagens: Imagem[] = Array.isArray(body?.imagens) ? body.imagens.slice(0, 3) : [];
  const contatoNome = body?.contato_nome ? String(body.contato_nome).slice(0, 120) : null;
  const forcar = body?.forcar === true;

  if (numero.length < 12 || numero.length > 13) throw new ProspectError("numero inválido (use DDI+DDD+número, ex.: 5515999999999)", 400, "numero_invalido");
  if (!texto) throw new ProspectError("texto obrigatório", 400, "texto_vazio");
  if (texto.length > 4000) throw new ProspectError("texto longo demais (máx. 4000)", 400, "texto_longo");
  for (const im of imagens) {
    const b = String(im?.base64 || "").replace(/^data:[^;]+;base64,/, "");
    if (!b) throw new ProspectError("imagem sem base64", 400, "imagem_invalida");
    if (b.length * 0.75 > MAX_IMAGEM_BYTES) throw new ProspectError("imagem grande demais (máx. ~2,5 MB)", 400, "imagem_grande");
    im.base64 = b;
  }

  const { data: inst } = await admin.from("whatsapp_instances")
    .select("instance_name, status").eq("company_id", companyId).maybeSingle();
  if (!inst || inst.status !== "connected") throw new ProspectError("WhatsApp desta empresa não está conectado", 409, "desconectado");

  // Pausado ou pediu para sair: nunca envia
  const { data: pausa } = await admin.from("contact_pause")
    .select("pausado").eq("company_id", companyId).eq("numero", numero).maybeSingle();
  if (pausa?.pausado) throw new ProspectError("contato pausado ou pediu para não receber mensagens", 409, "pausado");

  // Já existe conversa com esse número nesta empresa
  if (!forcar) {
    const { count } = await admin.from("mensagens")
      .select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("numero", numero);
    if ((count ?? 0) > 0) throw new ProspectError("já existe conversa com este número nesta empresa", 409, "ja_contatado");
  }

  // Limite diário e intervalo mínimo (contando só o texto da isca, 1 por contato)
  const { data: hoje } = await admin.from("mensagens")
    .select("created_at").eq("company_id", companyId).eq("autor", "prospeccao").eq("direcao", "saida")
    .not("texto", "like", "[imagem]%").gte("created_at", inicioDoDiaSP())
    .order("created_at", { ascending: false }).limit(500);
  const limite = Math.max(1, Math.min(LIMITE_DIA_PADRAO, Number(body?.limite_dia) || LIMITE_DIA_PADRAO));
  if ((hoje?.length ?? 0) >= limite) throw new ProspectError(`limite de ${limite} primeiros contatos por dia atingido`, 429, "limite_dia");
  const ultimo = hoje?.[0]?.created_at ? new Date(hoje[0].created_at).getTime() : 0;
  if (ultimo && Date.now() - ultimo < INTERVALO_MIN_MS) {
    const s = Math.ceil((INTERVALO_MIN_MS - (Date.now() - ultimo)) / 1000);
    throw new ProspectError(`aguarde ${s}s entre um primeiro contato e outro`, 429, "intervalo");
  }

  const { evoSendImage, evoSendText, evoSendPresence } = await import("@/lib/evolution.server");
  const registrar = (t: string) => admin.from("mensagens").insert({
    company_id: companyId, user_id: userId, numero, contato_nome: contatoNome,
    direcao: "saida", autor: "prospeccao", texto: t,
  });

  // 1) imagens
  let enviadas = 0;
  for (const [i, im] of imagens.entries()) {
    await evoSendImage(inst.instance_name, numero, im.base64, im.mimetype || "image/png", im.nome || `previa-${i + 1}.png`);
    await registrar(`[imagem] ${im.nome || `prévia ${i + 1}`} (prévia do site enviada na prospecção)`);
    enviadas++;
    await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  }
  // 2) texto, com "digitando…" antes
  try { void evoSendPresence(inst.instance_name, numero, "composing", 3000); } catch {}
  await new Promise((r) => setTimeout(r, 3000));
  await evoSendText(inst.instance_name, numero, texto);
  await registrar(texto);

  // 3) card no CRM (primeira etapa), sem sobrescrever um card existente
  try {
    const { data: card } = await admin.from("crm_cards").select("id").eq("company_id", companyId).eq("numero", numero).maybeSingle();
    if (!card) {
      const { data: st } = await admin.from("crm_stage").select("id, nome").eq("company_id", companyId).order("ordem", { ascending: true }).limit(1).maybeSingle();
      await admin.from("crm_cards").insert({
        company_id: companyId, user_id: userId, numero, nome: contatoNome,
        ultima_mensagem: texto.slice(0, 240), ultima_em: new Date().toISOString(),
        ...(st ? { stage_id: st.id, status: st.nome } : { status: "Conversas" }),
      });
    }
  } catch (e: any) { console.warn("[prospect] card", e?.message); }

  try {
    const { emitWebhook } = await import("@/lib/webhooks.server");
    void emitWebhook(companyId, "message.sent", { numero, origem: "prospeccao", ref_externa: body?.ref_externa ?? null, imagens: enviadas });
  } catch {}

  console.log(`[prospect] ${inst.instance_name} → ${numero.slice(0, 4)}…${numero.slice(-4)} imagens=${enviadas} ref=${String(body?.ref_externa || "").slice(0, 40)}`);
  return { ok: true, numero, imagens: enviadas, hoje: (hoje?.length ?? 0) + 1, limite };
}

// POST /api/public/v1?resource=checknumbers  body: { numeros: ["5515...", ...] } (até 50)
export async function conferirNumeros(companyId: string, body: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const numeros: string[] = (Array.isArray(body?.numeros) ? body.numeros : [])
    .map((n: any) => String(n || "").replace(/\D/g, "")).filter((n: string) => n.length >= 12 && n.length <= 13).slice(0, 50);
  if (!numeros.length) throw new ProspectError("envie numeros: [\"5515...\"]", 400, "sem_numeros");
  const { data: inst } = await (supabaseAdmin as any).from("whatsapp_instances")
    .select("instance_name, status").eq("company_id", companyId).maybeSingle();
  if (!inst || inst.status !== "connected") throw new ProspectError("WhatsApp desta empresa não está conectado", 409, "desconectado");
  const { evoCheckNumbers } = await import("@/lib/evolution.server");
  const r = await evoCheckNumbers(inst.instance_name, numeros);
  return {
    resultados: (Array.isArray(r) ? r : []).map((x: any) => ({
      numero: String(x?.number || "").replace(/\D/g, ""),
      whatsapp: !!x?.exists,
      jid: x?.jid || null,
    })),
  };
}
