// SERVER ONLY. Primeiro contato de prospecção vindo de fora (ex.: máquina de vendas da AW3S):
// POST /api/public/v1?resource=prospect  (Bearer azp_… da empresa/chip que vai enviar)
//
// body: {
//   numero: "5515999999999",
//   texto: "mensagem da isca",                  // ou textos: ["bloco 1", "bloco 2"] (até 4 mensagens)
//   imagens?: [{ base64, mimetype?, nome? }],   // até 3, enviadas antes do texto
//   pendente?: { textos: [...], imagens: [...] } // isca em 2 etapas: guardada e entregue na 1ª resposta (webhook)
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

// Limite diário POR TIPO (isca = autor "prospeccao", reforço = autor "reforco": cotas separadas, decisão do usuário em 2026-11-13)
// e intervalo mínimo entre QUAISQUER envios de prospecção do chip (isca ou reforço). Imagens não contam.
async function checarLimite(admin: any, companyId: string, body: any, autor: "prospeccao" | "reforco" = "prospeccao") {
  const { data: linhas } = await admin.from("mensagens")
    .select("numero").eq("company_id", companyId).eq("autor", autor).eq("direcao", "saida")
    .not("texto", "like", "[imagem]%").gte("created_at", inicioDoDiaSP())
    .order("created_at", { ascending: false }).limit(500);
  // conta CONTATOS, não mensagens: um reforço em 3 blocos é 1 reforço
  const hoje = [...new Set(((linhas ?? []) as any[]).map((m) => m.numero))];
  const limite = Math.max(1, Math.min(LIMITE_DIA_PADRAO, Number(body?.limite_dia) || LIMITE_DIA_PADRAO));
  const nome = autor === "reforco" ? "reforços" : "primeiros contatos";
  if ((hoje?.length ?? 0) >= limite) throw new ProspectError(`limite de ${limite} ${nome} por dia atingido`, 429, "limite_dia");
  const { data: ult } = await admin.from("mensagens")
    .select("created_at").eq("company_id", companyId).in("autor", ["prospeccao", "reforco"]).eq("direcao", "saida")
    .order("created_at", { ascending: false }).limit(1);
  const ultimo = ult?.[0]?.created_at ? new Date(ult[0].created_at).getTime() : 0;
  if (ultimo && Date.now() - ultimo < INTERVALO_MIN_MS) {
    const s = Math.ceil((INTERVALO_MIN_MS - (Date.now() - ultimo)) / 1000);
    throw new ProspectError(`aguarde ${s}s entre um contato de prospecção e outro`, 429, "intervalo");
  }
  return { hoje: (hoje ?? []) as any[], limite };
}

export async function enviarProspeccao(companyId: string, userId: string, body: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  const numero = String(body?.numero || "").replace(/\D/g, "");
  // texto único OU textos em blocos (cada um vira uma mensagem, com "digitando…" antes)
  const textos: string[] = (Array.isArray(body?.textos) ? body.textos : [body?.texto]).map((t: any) => String(t || "").trim()).filter(Boolean).slice(0, 4);
  const texto = textos.join("\n\n");
  const imagens: Imagem[] = Array.isArray(body?.imagens) ? body.imagens.slice(0, 3) : [];
  const contatoNome = body?.contato_nome ? String(body.contato_nome).slice(0, 120) : null;
  const forcar = body?.forcar === true;
  // Isca em duas etapas (2026-11-13): "pendente" = { textos, imagens } guardados e entregues quando o contato responder
  const pendente = body?.pendente && typeof body.pendente === "object" ? {
    textos: (Array.isArray(body.pendente.textos) ? body.pendente.textos : []).map((t: any) => String(t || "").trim()).filter(Boolean).slice(0, 4),
    imagens: (Array.isArray(body.pendente.imagens) ? body.pendente.imagens : []).slice(0, 3) as Imagem[],
  } : null;

  if (numero.length < 12 || numero.length > 13) throw new ProspectError("numero inválido (use DDI+DDD+número, ex.: 5515999999999)", 400, "numero_invalido");
  if (!texto) throw new ProspectError("texto obrigatório", 400, "texto_vazio");
  if (texto.length > 4000) throw new ProspectError("texto longo demais (máx. 4000)", 400, "texto_longo");
  if (pendente && !pendente.textos.length && !pendente.imagens.length) throw new ProspectError("isca pendente vazia", 400, "pendente_vazia");
  if (pendente && pendente.textos.join("").length > 4000) throw new ProspectError("isca pendente longa demais (máx. 4000)", 400, "texto_longo");
  for (const im of [...imagens, ...(pendente?.imagens ?? [])]) {
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

  const { hoje, limite } = await checarLimite(admin, companyId, body);

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
  // 2) texto(s), cada bloco com "digitando…" antes
  for (const [i, t] of textos.entries()) {
    const digitando = Math.min(7000, 2500 + t.length * 35);
    try { void evoSendPresence(inst.instance_name, numero, "composing", digitando); } catch {}
    await new Promise((r) => setTimeout(r, digitando));
    await evoSendText(inst.instance_name, numero, t);
    await registrar(t);
    if (i < textos.length - 1) await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  }

  // 3) isca guardada para a primeira resposta do contato
  if (pendente) {
    const { error } = await admin.from("prospeccao_pendente").upsert({
      company_id: companyId, numero, textos: pendente.textos, imagens: pendente.imagens,
      ref_externa: body?.ref_externa ?? null, status: "pendente", erro: null, entregue_em: null, created_at: new Date().toISOString(),
    }, { onConflict: "company_id,numero" });
    if (error) console.error("[prospect] pendente", error.message);
  }

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

  console.log(`[prospect] ${inst.instance_name} → ${numero.slice(0, 4)}…${numero.slice(-4)} blocos=${textos.length} imagens=${enviadas} pendente=${!!pendente} ref=${String(body?.ref_externa || "").slice(0, 40)}`);
  return { ok: true, numero, blocos: textos.length, imagens: enviadas, pendente: !!pendente, hoje: (hoje?.length ?? 0) + 1, limite };
}

// ---- Isca em duas etapas, conduzida pela IA (usuário, 2026-11-13) ----
// A abertura vai sozinha. Quando o contato responde, quem conversa é a IA da empresa (ex.: Katia, já treinada):
// ela recebe no contexto o material real da isca, trabalha as objeções e, na hora certa, escreve [MOSTRAR_PREVIA];
// o webhook então envia os prints guardados logo depois da mensagem dela. Resposta negativa cancela a isca.
const NEGATIVO = /n[aã]o (tenho |temos )?interesse|n[aã]o (quero|queremos|preciso)|desinteress|n[aã]o (mande|envie)|spam|golpe|quem te deu (meu|esse) n[uú]mero/i;
// Resposta que chega até 15 s depois do 1º envio de prospecção = saudação automática do WhatsApp Business (robô),
// não uma pessoa (casos reais de 11/11: 3 a 4 s). A IA não conversa com ela e o reforço não a conta como resposta.
const JANELA_AUTOMATICA_MS = 15_000;
export async function ehRespostaAutomatica(companyId: string, numero: string, recebidaEm: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any).from("mensagens").select("created_at")
    .eq("company_id", companyId).eq("numero", numero).eq("direcao", "saida").eq("autor", "prospeccao")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!data?.created_at) return false;
  const dt = new Date(recebidaEm).getTime() - new Date(data.created_at).getTime();
  return dt >= 0 && dt <= JANELA_AUTOMATICA_MS;
}
export const MARCADOR_PREVIA =/\[\s*MOSTRAR[_ ]PREVIA\s*\]/gi;

export async function buscarIscaPendente(companyId: string, numero: string, textoRecebido: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  if (NEGATIVO.test(textoRecebido || "")) {
    await admin.from("prospeccao_pendente").update({ status: "cancelado", erro: "resposta negativa" })
      .eq("company_id", companyId).eq("numero", numero).eq("status", "pendente");
    return null;
  }
  const { data } = await admin.from("prospeccao_pendente").select("id, textos, ref_externa")
    .eq("company_id", companyId).eq("numero", numero).eq("status", "pendente").maybeSingle();
  return (data as { id: string; textos: string[]; ref_externa: string | null } | null) ?? null;
}

export function instrucaoIsca(p: { textos: string[] }) {
  return `

## Prospecção: há uma prévia de site pronta para este contato
Você (ou a empresa) mandou a mensagem de abertura para este contato, e ele respondeu. O time da AW3S já criou um modelo exclusivo de site para a empresa dele, e os prints estão prontos para enviar.
Material REAL desta prospecção (use à vontade, com as suas palavras; não invente nada além disso):
"""
${(p.textos || []).join("\n\n")}
"""
Como conduzir:
- Converse de forma natural e curta, como uma pessoa. Responda dúvidas e objeções com calma ("quem é você?", "quanto custa?", "não tenho tempo", "já tenho site"…), sempre puxando para mostrar a prévia: é ela que gera o interesse.
- Quando o contato topar ver, mostrar curiosidade ou for o momento natural, escreva uma frase curta apresentando a prévia e coloque no FINAL da resposta o marcador [MOSTRAR_PREVIA]. O sistema envia os prints do site logo depois da sua mensagem. Use o marcador uma única vez e não diga que "vai enviar imagens" sem usá-lo.
- Depois dos prints, convide-o a responder SIM para receber a versão completa e navegar pelo celular.
- Se ele disser que não tem interesse, agradeça com educação e não insista.`;
}

// Envia os prints guardados (uma única vez, mesmo com mensagens simultâneas). true = enviou.
export async function enviarPrintsPendentes(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: p } = await admin.from("prospeccao_pendente").update({ status: "entregando" })
    .eq("company_id", companyId).eq("numero", numero).eq("status", "pendente").select("*").maybeSingle();
  if (!p) return false;
  const { evoSendImage } = await import("@/lib/evolution.server");
  try {
    for (const [i, im] of ((p.imagens ?? []) as Imagem[]).entries()) {
      await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1200)));
      await evoSendImage(instanceName, numero, im.base64, im.mimetype || "image/png", im.nome || `previa-${i + 1}.png`);
      await admin.from("mensagens").insert({
        company_id: companyId, user_id: userId, numero, contato_nome: contatoNome, direcao: "saida", autor: "prospeccao",
        texto: `[imagem] ${im.nome || `prévia ${i + 1}`} (prévia do site enviada na prospecção)`,
      });
    }
    await admin.from("prospeccao_pendente").update({ status: "entregue", entregue_em: new Date().toISOString(), imagens: [] }).eq("id", p.id);
    try {
      const { emitWebhook } = await import("@/lib/webhooks.server");
      void emitWebhook(companyId, "message.sent", { numero, origem: "isca_entregue", ref_externa: p.ref_externa ?? null });
    } catch {}
    console.log(`[isca] prints entregues → ${numero.slice(0, 4)}…${numero.slice(-4)} ref=${String(p.ref_externa || "").slice(0, 40)}`);
    return true;
  } catch (e: any) {
    await admin.from("prospeccao_pendente").update({ status: "erro", erro: String(e?.message ?? e).slice(0, 300) }).eq("id", p.id);
    console.error("[isca] prints", e?.message);
    return false;
  }
}

// POST /api/public/v1?resource=reforco  body: { numero, texto, ref_externa?, limite_dia? }
// Segundo e ÚLTIMO contato de prospecção, só texto, na conversa que a isca abriu (máquina de vendas, 2026-11-13).
// Travas: conectado; contato não pausado; existe a isca (prospeccao/saida) há pelo menos MIN_DIAS_REFORCO dias;
// o cliente NUNCA respondeu (nenhuma mensagem de entrada); ainda não houve reforço; limite diário e intervalo da prospecção.
const MIN_DIAS_REFORCO = 2;
export async function enviarReforco(companyId: string, userId: string, body: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const numero = String(body?.numero || "").replace(/\D/g, "");
  // Em blocos: textos = ["msg 1", "msg 2", …] (até 4), enviados como mensagens separadas com "digitando…" entre elas.
  const textos: string[] = (Array.isArray(body?.textos) ? body.textos : [body?.texto]).map((t: any) => String(t || "").trim()).filter(Boolean);
  if (numero.length < 12 || numero.length > 13) throw new ProspectError("numero inválido (use DDI+DDD+número, ex.: 5515999999999)", 400, "numero_invalido");
  if (!textos.length) throw new ProspectError("texto obrigatório", 400, "texto_vazio");
  if (textos.length > 4) throw new ProspectError("no máximo 4 blocos por reforço", 400, "blocos_demais");
  if (textos.join("").length > 1500) throw new ProspectError("reforço longo demais (máx. 1500 no total)", 400, "texto_longo");

  const { data: inst } = await admin.from("whatsapp_instances")
    .select("instance_name, status").eq("company_id", companyId).maybeSingle();
  if (!inst || inst.status !== "connected") throw new ProspectError("WhatsApp desta empresa não está conectado", 409, "desconectado");
  const { data: pausa } = await admin.from("contact_pause")
    .select("pausado").eq("company_id", companyId).eq("numero", numero).maybeSingle();
  if (pausa?.pausado) throw new ProspectError("contato pausado ou pediu para não receber mensagens", 409, "pausado");

  const { data: conversa } = await admin.from("mensagens")
    .select("direcao, autor, texto, created_at, contato_nome").eq("company_id", companyId).eq("numero", numero)
    .order("created_at", { ascending: true }).limit(500);
  const msgs: any[] = conversa ?? [];
  const textosProsp = msgs.filter((m) => m.direcao === "saida" && m.autor === "prospeccao" && !String(m.texto || "").startsWith("[imagem]"));
  if (!textosProsp.length) throw new ProspectError("não há isca enviada para este número nesta empresa", 409, "sem_isca");
  // saudação automática do WhatsApp Business (chega segundos depois da isca) não conta como resposta
  const t0 = new Date(msgs.find((m) => m.direcao === "saida" && m.autor === "prospeccao")?.created_at ?? 0).getTime();
  if (msgs.some((m) => m.direcao === "entrada" && new Date(m.created_at).getTime() - t0 > JANELA_AUTOMATICA_MS)) throw new ProspectError("o contato já respondeu: o reforço não é enviado", 409, "respondeu");
  if (msgs.some((m) => m.direcao === "saida" && m.autor === "reforco")) throw new ProspectError("este contato já recebeu o reforço", 409, "ja_reforcado");
  const dias = (Date.now() - new Date(textosProsp[0].created_at).getTime()) / 864e5;
  if (dias < MIN_DIAS_REFORCO) throw new ProspectError(`a isca foi enviada há menos de ${MIN_DIAS_REFORCO} dias`, 409, "cedo_demais");

  const { hoje, limite } = await checarLimite(admin, companyId, body, "reforco");

  const { evoSendText, evoSendPresence } = await import("@/lib/evolution.server");
  const contatoNome = msgs.find((m) => m.contato_nome)?.contato_nome ?? null;
  for (const [i, texto] of textos.entries()) {
    // "digitando…" proporcional ao tamanho do bloco (2,5 s a 7 s), como uma pessoa escrevendo
    const digitando = Math.min(7000, 2500 + texto.length * 35);
    try { void evoSendPresence(inst.instance_name, numero, "composing", digitando); } catch {}
    await new Promise((r) => setTimeout(r, digitando));
    await evoSendText(inst.instance_name, numero, texto);
    await admin.from("mensagens").insert({ company_id: companyId, user_id: userId, numero, contato_nome: contatoNome, direcao: "saida", autor: "reforco", texto });
    if (i < textos.length - 1) await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  }
  const texto = textos[textos.length - 1];
  try {
    await admin.from("crm_cards").update({ ultima_mensagem: texto.slice(0, 240), ultima_em: new Date().toISOString() })
      .eq("company_id", companyId).eq("numero", numero);
  } catch {}
  try {
    const { emitWebhook } = await import("@/lib/webhooks.server");
    void emitWebhook(companyId, "message.sent", { numero, origem: "reforco", ref_externa: body?.ref_externa ?? null });
  } catch {}
  console.log(`[reforco] ${inst.instance_name} → ${numero.slice(0, 4)}…${numero.slice(-4)} blocos=${textos.length} ref=${String(body?.ref_externa || "").slice(0, 40)}`);
  return { ok: true, numero, blocos: textos.length, hoje: hoje.length + 1, limite };
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
