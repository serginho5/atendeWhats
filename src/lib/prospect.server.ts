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

// Número como o WhatsApp registra o contato (2026-11-20, caso Mania Games): celulares antigos de DDD 31 para cima
// costumam estar SEM o 9 ("554796471395"). Se a abertura sai com o 9, a resposta chega pelo número sem 9, vira
// "outra conversa" e a IA perde o contexto da prospecção (e não reconhece o robô). Pergunta ao WhatsApp o jid.
async function numeroCanonico(instanceName: string, numero: string): Promise<string> {
  try {
    const { evoCheckNumbers } = await import("@/lib/evolution.server");
    const r = await evoCheckNumbers(instanceName, [numero]);
    const x = (Array.isArray(r) ? r : [])[0];
    const jid = String(x?.jid || "").split("@")[0].replace(/\D/g, "");
    if (x?.exists && jid.length >= 12 && jid.length <= 13 && jid.slice(-8) === numero.slice(-8)) return jid;
  } catch (e: any) { console.error("[numero canonico]", e?.message); }
  return numero;
}

export async function enviarProspeccao(companyId: string, userId: string, body: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;

  let numero = String(body?.numero || "").replace(/\D/g, "");
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
  numero = await numeroCanonico(inst.instance_name, numero); // grava tudo no número que o WhatsApp usa (com ou sem 9)

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
// Texto típico de robô do WhatsApp Business (casos reais de 16/11: "estamos ausentes... nosso horário é",
// "Seja muito bem-vindo(a) à ...", "Olá, bem vindo a Loja ..." chegando 7 h depois). Só é usado enquanto a
// última mensagem nossa for de prospecção/reforço, isto é, antes de existir conversa de verdade.
const TEXTO_AUTOMATICO = /estamos ausentes|n[oa] momento (n[aã]o )?(estamos|podemos|conseguimos)|seja (muito )?bem[- ]?vind|bem[- ]?vind[oa](\(a\))? (a|à|ao)\s|hor[aá]rio de (atendimento|funcionamento)|nosso hor[aá]rio|fora do (nosso )?hor[aá]rio|responderemos (assim que|em breve|o mais)|retornaremos (assim que|em breve|o (seu )?contato)|agradece(mos)? (o )?(seu )?contato|mensagem autom[aá]tica|deixe (a )?sua mensagem/i;
export const pareceAutomatica = (texto: string) => TEXTO_AUTOMATICO.test(texto || "");
const AUTORES_PROSPECCAO = ["prospeccao", "reforco"];

// Sinais de pessoa (caso real de 17/11: a secretária da Dra. Audrey mandou ÁUDIO dizendo "Bom dia, Cátia...
// Seja bem-vinda à Personalized Concept... posso ajudar?" e a Katia ficou calada). Robô não manda voz e não
// sabe o nome de quem escreveu; quem cita a Katia leu a nossa mensagem.
const CITA_CONSULTORA = /[kc][aá]t(h)?ia/i;
export async function ehRespostaAutomatica(companyId: string, numero: string, recebidaEm: string, texto = "", opts: { audio?: boolean } = {}) {
  if (opts.audio || CITA_CONSULTORA.test(texto || "")) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // a última mensagem nossa antes desta (abertura, reforço ou conversa da IA/humano)
  const { data } = await (supabaseAdmin as any).from("mensagens").select("autor, created_at")
    .eq("company_id", companyId).eq("numero", numero).eq("direcao", "saida").lte("created_at", recebidaEm)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data?.created_at || !AUTORES_PROSPECCAO.includes(data.autor)) return false;
  const dt = new Date(recebidaEm).getTime() - new Date(data.created_at).getTime();
  return (dt >= 0 && dt <= JANELA_AUTOMATICA_MS) || pareceAutomatica(texto);
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
  const { data } = await admin.from("prospeccao_pendente").select("id, textos, ref_externa, erro")
    .eq("company_id", companyId).eq("numero", numero).eq("status", "pendente").maybeSingle();
  return (data as { id: string; textos: string[]; ref_externa: string | null; erro?: string | null } | null) ?? null;
}

export const MARCADOR_ATENDE = "[ATENDE+]";

// ---- Robô de atendimento → trilha Atende+ no mesmo dia (usuário, 2026-11-20) ----
// 1. O robô do contato respondeu à abertura: a Katia pede, UMA vez e ~75 s depois, para falar com uma pessoa. Isso chama a
//    atenção do responsável para a conversa. A prospecção vira Atende+ (sem prints de site). Estado em prospeccao_pendente.erro:
//    null → "pediu_pessoa" → "apresentou".
// 2. Uma pessoa responde: sai o texto do Sérgio (fixo, sem IA) com o nome dela e o tempo real desde o 1º contato. Depois a
//    IA conduz até "Posso te apresentar uma solução?" e a reunião.
export const MENSAGEM_PEDIR_PESSOA = "Gostaria de falar com uma pessoa. Assim que possível, me chame por aqui!";
const ATRASO_PEDIR_PESSOA_MS = 75_000;

const tempoDesde = (iso: string) => {
  const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} minuto${min > 1 ? "s" : ""}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hora${h > 1 ? "s" : ""}`;
  const d = Math.round(h / 24);
  return `${d} dias`;
};
const primeiroNome = (n?: string | null) => {
  const p = String(n || "").replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/)[0] || "";
  return p.length >= 2 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : "";
};
export function textoApresentarDado(nome: string, tempo: string) {
  return [
    `Olá, tudo bem${nome ? `, ${nome}` : ""}? Tenho um dado importante para te apresentar: meu primeiro contato com vocês foi há ${tempo}, e o sistema robotizado não me causou interesse em interagir com ele.`,
    "Já imaginou quantos clientes encontram vocês no Google, caem no WhatsApp de vocês e desistem de contratar os seus serviços por se depararem com um robô?",
  ];
}

async function enviarComoKatia(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null, textos: string[], autor: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { evoSendText, evoSendPresence } = await import("@/lib/evolution.server");
  for (const [i, texto] of textos.entries()) {
    const digitando = Math.min(7000, 2500 + texto.length * 35);
    try { void evoSendPresence(instanceName, numero, "composing", digitando); } catch {}
    await new Promise((r) => setTimeout(r, digitando));
    await evoSendText(instanceName, numero, texto);
    await (supabaseAdmin as any).from("mensagens").insert({ company_id: companyId, user_id: userId, numero, contato_nome: contatoNome, direcao: "saida", autor, texto });
    if (i < textos.length - 1) await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  }
}

// Chamado pelo webhook quando a resposta é de robô. Só age em prospecção com isca pendente e só uma vez (trava atômica no erro).
export async function pedirPessoa(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: pend } = await admin.from("prospeccao_pendente").select("id, textos, erro")
    .eq("company_id", companyId).eq("numero", numero).eq("status", "pendente").maybeSingle();
  if (!pend || pend.erro) return false; // sem prospecção pendente, ou já pediu / já está na trilha Atende+
  const { data: travou } = await admin.from("prospeccao_pendente")
    .update({ erro: "pediu_pessoa", textos: [MARCADOR_ATENDE, "", MENSAGEM_PEDIR_PESSOA], imagens: [] })
    .eq("id", pend.id).is("erro", null).select("id");
  if (!travou?.length) return false;
  setTimeout(async () => {
    try {
      // se uma pessoa já respondeu nesse meio-tempo, não pede mais
      const { data: atual } = await admin.from("prospeccao_pendente").select("erro, status").eq("id", pend.id).maybeSingle();
      if (!atual || atual.status !== "pendente" || atual.erro !== "pediu_pessoa") return;
      // autor "prospeccao": as próximas mensagens automáticas do robô continuam sendo reconhecidas como robô
      await enviarComoKatia(companyId, userId, instanceName, numero, contatoNome, [MENSAGEM_PEDIR_PESSOA], "prospeccao");
      console.log(`[atende+] pediu pessoa → ${numero.slice(0, 4)}…${numero.slice(-4)}`);
    } catch (e: any) { console.error("[atende+ pedir pessoa]", e?.message); }
  }, ATRASO_PEDIR_PESSOA_MS);
  return true;
}

// Chamado pelo webhook quando uma PESSOA responde numa conversa da trilha Atende+ que ainda não recebeu o dado.
// Envia o texto fixo do Sérgio e devolve true (o webhook não chama a IA nesta mensagem).
export async function apresentarDado(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null, pend: { id: string; textos: string[]; erro?: string | null }) {
  if ((pend.textos || [])[0] !== MARCADOR_ATENDE || pend.erro !== "pediu_pessoa") return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: travou } = await admin.from("prospeccao_pendente").update({ erro: "apresentou" }).eq("id", pend.id).eq("erro", "pediu_pessoa").select("id");
  if (!travou?.length) return false;
  const { data: primeira } = await admin.from("mensagens").select("created_at").eq("company_id", companyId).eq("numero", numero)
    .eq("direcao", "saida").eq("autor", "prospeccao").order("created_at", { ascending: true }).limit(1).maybeSingle();
  const textos = textoApresentarDado(primeiroNome(contatoNome), tempoDesde(primeira?.created_at || new Date().toISOString()));
  await admin.from("prospeccao_pendente").update({ textos: [MARCADOR_ATENDE, pend.textos?.[1] || "", textos.join("\n\n")] }).eq("id", pend.id);
  await enviarComoKatia(companyId, userId, instanceName, numero, contatoNome, textos, "ia");
  return true;
}

// Trilha Atende+ (2026-11-20): o contato tem robô de atendimento. O objetivo é marcar uma reunião sobre atendimento humanizado.
// O site entra depois, como serviço agregado.
function instrucaoAtende(roteiro: string, enviado: string, apresentou = false) {
  return `

## Prospecção Atende+: atendimento humanizado (NÃO é sobre site)
Quem respondeu à nossa abertura foi um robô de atendimento automático deste contato. ${apresentou
    ? "Quando uma pessoa finalmente respondeu, você já mandou esta mensagem, com o dado real:"
    : "Você mandou esta mensagem, e o contato respondeu agora:"}
"""
${enviado}
"""
${apresentou ? `PRÓXIMO PASSO (a cartada): reaja ao que a pessoa disse em UMA frase curta e faça a pergunta rápida e objetiva "Posso te apresentar uma solução?". Só depois do "sim" explique a solução em poucas linhas e proponha a reunião. Não repita o dado que já foi dito.\n` : ""}
O produto é o Atende+: atendimento que conversa como gente, 24 horas, agenda horários com a equipe e filtra quem está realmente interessado de quem só quer tirar dúvida.
OBJETIVO: marcar uma reunião curta com o responsável (dia e horário). Não fale de site, de prévia nem de prints, e NUNCA use o marcador [MOSTRAR_PREVIA]. O site só aparece depois, na reunião, como serviço agregado.
- Converse como pessoa: mensagens curtas, uma ideia por vez, sem parecer robô. Nunca finja ser cliente.
- Use a dor real, com tato: vocês mesmos viram o robô responder e ninguém atender. Sem tom de acusação.
- Se perguntarem se você é robô, não negue: você é a assistente de novos negócios da AW3S, e esta conversa é um exemplo de como o atendimento humanizado funciona.
- Logo depois que a pessoa disser que pode apresentar a solução, ANTES de explicar, apresente-se formalmente, como uma pessoa faria: "Desculpa, não me apresentei direito: sou a Katia, consultora de novos negócios da AW3S." (com as suas palavras, curto). Só então explique a solução.
- Sempre que sugerir ou confirmar a reunião, apresente o Sérgio como gerente de projetos da AW3S (ex.: "o Sérgio, nosso gerente de projetos, te mostra funcionando"). Para marcar, siga o passo a passo de "COMO MARCAR A REUNIÃO" abaixo.
- Ao se despedir (reunião marcada, "vou pensar" ou até "não tenho interesse"), deixe sempre o site da AW3S para a pessoa conhecer quem somos: https://aw3s.com.br
- Se não tiver interesse, agradeça com educação, deixe o site e não insista.
- NUNCA informe preço, valor, faixa de preço nem forma de pagamento, nem se insistirem: diga com leveza que depende do volume de atendimentos de cada empresa e que o Sérgio mostra tudo na reunião.

COMO MARCAR A REUNIÃO (siga esta ordem, uma etapa por mensagem):
1. Pergunte a preferência: "Você prefere a reunião ainda hoje ou amanhã?"
2. Consulte os HORÁRIOS LIVRES DE VERDADE (lista abaixo, quando houver) e sugira UM horário do dia escolhido ("Tenho às 15h, fica bom?"). Se não servir, ofereça outro da lista. Nunca invente horário fora da lista.
3. Quando a pessoa escolher, peça o e-mail dela para mandar o convite, e avise: "Nossas reuniões são pelo Google Meet e levam no máximo 30 minutos."
4. Com o horário e o e-mail confirmados, diga só "Perfeito, vou marcar aqui 😊" e, na MESMA resposta, em uma nova linha, escreva exatamente:
   [AGENDAR: INÍCIO | FIM | Reunião AW3S: atendimento humanizado | EMAIL]
   (INÍCIO = horário escolhido com -03:00, ex.: 2026-11-21T15:00:00-03:00; FIM = 30 min depois; EMAIL = o e-mail que a pessoa passou). Não diga que já está marcado: o sistema marca e manda a confirmação com o pedido para conferir se o convite chegou.
5. Quando a pessoa confirmar que o convite chegou, agradeça, diga que o Sérgio, nosso gerente de projetos, estará na reunião, deixe o site https://aw3s.com.br e, na MESMA resposta, em uma nova linha, escreva [HANDOFF: reunião marcada]. Se o convite não chegou, peça para olhar o spam e confirmar o e-mail.
${roteiro.trim() ? `\nRoteiro do Sérgio (siga este roteiro; ele vale mais que as regras gerais acima, menos a regra de não falar de site):\n"""\n${roteiro.trim()}\n"""` : ""}`;
}

export function instrucaoIsca(p: { textos: string[]; erro?: string | null }) {
  if ((p.textos || [])[0] === MARCADOR_ATENDE) return instrucaoAtende(p.textos[1] || "", p.textos[2] || "", p.erro === "apresentou");
  return `

## Prospecção: há uma prévia de site pronta para este contato
Você (ou a empresa) mandou a mensagem de abertura para este contato, e ele respondeu. O time da AW3S já criou um modelo exclusivo de site para a empresa dele, e os prints estão prontos para enviar.
Material REAL desta prospecção (use à vontade, com as suas palavras; não invente nada além disso):
"""
${(p.textos || []).join("\n\n")}
"""
Como conduzir:
- ATENÇÃO: o contato ainda NÃO recebeu nenhuma imagem. A abertura foi só: "Bom dia, tudo bem com você? Aqui é a Katia, encontrei vocês no Google. Como está a agenda de vocês? Estão abertos a novos clientes?" (ou, 3 dias depois, "Vocês ainda estão aceitando novos clientes?"). Não pergunte se ele "viu a demonstração/prévia" nem fale de imagens "acima" ou "que mandei".
- O contato pode achar que você é uma CLIENTE querendo agendar ou fazer orçamento. NUNCA finja ser cliente, não peça horário, preço nem serviço. Já na sua PRIMEIRA resposta, agradeça o retorno e conte com transparência e leveza por que perguntou, ligando com o que ele respondeu. Tom acolhedor, de quem quer ver a empresa crescer e ganhar mais dinheiro, nunca de vendedor. Exemplo (siga esta forma): se disse que está aberto a clientes → "Que bom! 😊 Te perguntei porque eu ajudo empresas aqui da região a atrair mais clientes pelo Google. Vi que a [empresa] tem ótimas avaliações e está fazendo um trabalho excelente no seu segmento. Posso te ajudar a fortalecer ainda mais a autoridade de vocês e trazer muito mais clientes?". Use a nota e o número de avaliações reais do material quando houver. Quando ele topar, conte que você já montou um rascunho de site para a empresa e mostre ([MOSTRAR_PREVIA]). Se disse que a agenda está cheia → elogie e diga que um site ajuda a selecionar melhores clientes e valorizar o preço. Se perguntou "o que você precisa?" → explique sem rodeio que não é para agendar, é uma ideia para trazer mais clientes. Peça desculpas pela confusão se ele parecer frustrado.
- Se quem respondeu for funcionário(a) ou secretária, seja simpática, diga em 1 ou 2 frases quem você é e por que escreveu, e ofereça mostrar a prévia para ele(a) repassar ao responsável.
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
  let numero = String(body?.numero || "").replace(/\D/g, "");
  // Em blocos: textos = ["msg 1", "msg 2", …] (até 4), enviados como mensagens separadas com "digitando…" entre elas.
  const textos: string[] = (Array.isArray(body?.textos) ? body.textos : [body?.texto]).map((t: any) => String(t || "").trim()).filter(Boolean);
  if (numero.length < 12 || numero.length > 13) throw new ProspectError("numero inválido (use DDI+DDD+número, ex.: 5515999999999)", 400, "numero_invalido");
  if (!textos.length) throw new ProspectError("texto obrigatório", 400, "texto_vazio");
  if (textos.length > 4) throw new ProspectError("no máximo 4 blocos por reforço", 400, "blocos_demais");
  if (textos.join("").length > 1500) throw new ProspectError("reforço longo demais (máx. 1500 no total)", 400, "texto_longo");

  const { data: inst } = await admin.from("whatsapp_instances")
    .select("instance_name, status").eq("company_id", companyId).maybeSingle();
  if (!inst || inst.status !== "connected") throw new ProspectError("WhatsApp desta empresa não está conectado", 409, "desconectado");
  // A abertura nova já fica gravada no número do WhatsApp (com ou sem 9); usa esse número se a prospecção estiver nele
  const canon = await numeroCanonico(inst.instance_name, numero);
  if (canon !== numero) {
    const { count } = await admin.from("mensagens").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("numero", canon).eq("autor", "prospeccao");
    if ((count ?? 0) > 0) numero = canon;
  }
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
  // Atende+ (máquina de vendas, 2026-11-20): tipo "atende" = 2º contato de atendimento humanizado, no dia seguinte, para quem
  // tem robô de atendimento e nenhuma pessoa respondeu. A máquina já conferiu que não houve pessoa (regra de robô mais ampla),
  // então aqui não se barra por "respondeu"; libera a partir de 12 h depois da abertura.
  const atende = body?.tipo === "atende";
  if (!atende && msgs.some((m) => m.direcao === "entrada" && new Date(m.created_at).getTime() - t0 > JANELA_AUTOMATICA_MS && !pareceAutomatica(m.texto))) throw new ProspectError("o contato já respondeu: o reforço não é enviado", 409, "respondeu");
  if (msgs.some((m) => m.direcao === "saida" && m.autor === "reforco")) throw new ProspectError("este contato já recebeu o reforço", 409, "ja_reforcado");
  const dias = (Date.now() - new Date(textosProsp[0].created_at).getTime()) / 864e5;
  const minDias = atende ? 0.5 : MIN_DIAS_REFORCO;
  if (dias < minDias) throw new ProspectError(`a isca foi enviada há menos de ${minDias} dias`, 409, "cedo_demais");

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
  // Atende+: a conversa daqui em diante é sobre atendimento humanizado (reunião), não sobre o site. Troca o material
  // pendente da Katia pelo roteiro do Atende+ (sem prints); o instrucaoIsca reconhece o marcador [ATENDE+].
  if (atende) {
    const material = [MARCADOR_ATENDE, String(body?.instrucao || "").slice(0, 6000), textos.join("\n\n")];
    const { data: pend } = await admin.from("prospeccao_pendente").select("id").eq("company_id", companyId).eq("numero", numero).maybeSingle();
    if (pend) await admin.from("prospeccao_pendente").update({ textos: material, imagens: [], status: "pendente", erro: null }).eq("id", pend.id);
    else await admin.from("prospeccao_pendente").insert({ company_id: companyId, numero, textos: material, imagens: [], ref_externa: body?.ref_externa ?? null, status: "pendente" });
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
