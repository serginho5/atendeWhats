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
  let hoje = [...new Set(((linhas ?? []) as any[]).map((m) => m.numero))];
  // Primeiro contato = número que NÃO tinha conversa antes de hoje. Continuação com quem já foi abordado em outro dia
  // (ex.: "Gostaria de falar com uma pessoa" para o robô, entrega dos prints) não come a cota de aberturas (caso Vitória Amaro, 24/11).
  if (autor === "prospeccao" && hoje.length) {
    const { data: antigos } = await admin.from("mensagens")
      .select("numero").eq("company_id", companyId).in("numero", hoje).lt("created_at", inicioDoDiaSP()).limit(1000);
    const jaTinha = new Set(((antigos ?? []) as any[]).map((m) => m.numero));
    hoje = hoje.filter((n) => !jaTinha.has(n));
  }
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
  const { data } = await admin.from("prospeccao_pendente").select("id, textos, ref_externa, erro, status, entregue_em")
    .eq("company_id", companyId).eq("numero", numero).in("status", ["pendente", "entregue"]).maybeSingle();
  // Prints já entregues (2026-11-20): a Katia continua com o contexto da prospecção por 7 dias (reagir à prévia, chamar para a completa)
  if (data?.status === "entregue" && (!data.entregue_em || Date.now() - new Date(data.entregue_em).getTime() > 7 * 864e5)) return null;
  return (data as { id: string; textos: string[]; ref_externa: string | null; erro?: string | null; status?: string } | null) ?? null;
}

export const MARCADOR_ATENDE = "[ATENDE+]";
// Seguimento logo depois dos prints do site (texto do Sérgio, 2026-11-20)
export const TEXTO_DEPOIS_DOS_PRINTS = [
  "Tomei a liberdade de pedir para o time de designers construir esse modelo inicial de site para vocês.",
  "O que achou? Ficou do seu agrado?",
  "É uma prévia, é claro. Se interessar, podemos desenvolver o site todo, que irá agregar muito à autoridade que vocês já têm hoje.",
];
const TEXTO_DEPOIS_RESUMO = TEXTO_DEPOIS_DOS_PRINTS.map((t) => `"${t}"`).join(" / ");

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
// Perfil do WhatsApp com nome comercial (caso Abrakadabra, 2026-11-21: "Buffet Abrakadabra" virou "Olá, tudo bem, Buffet?").
// Só usa o primeiro nome quando o perfil parece de pessoa.
const NOME_EMPRESA = /buffet|festa|evento|sal[aã]o|kids|infantil|espa[cç]o|ltda|eireli|\bme\b|oficial|loja|cl[ií]nica|studio|est[uú]dio|atendimento|comercial|marmor|granito|decora|est[eé]tica|consult|servi[cç]o|restaurante|pizzaria|bar\b|caf[eé]|ateli[eê]|brech[oó]|academia|\bpet\b|odonto|advoca|imobili|grupo|empresa|center|centro|\bcasa\b|\bbar\b|games?\b|divers|brinquedo|beleza|sorocaba|recep[cç]|\d/i;
export const primeiroNome = (n?: string | null) => {
  const s = String(n || "");
  if (NOME_EMPRESA.test(s)) return "";
  const p = s.replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/)[0] || "";
  return p.length >= 2 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : "";
};
const saudacaoSP = () => {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false })) % 24;
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
};
// A pessoa achou que a Katia é cliente (caso Abrakadabra: "Claro! Para quando é a festa?")
const ACHOU_CLIENTE = /para quando|qual (a )?(data|dia)|quantas (pessoas|crian[cç]as|convidados)|or[cç]amento|como (posso|podemos) (te |lhe )?ajudar|em que (posso|podemos)|o que (voc[eê] )?(precisa|gostaria|deseja)|qual servi[cç]o|festa|evento|agendar|hor[aá]rio/i;
// Texto do Sérgio (2026-11-20) + fecho com a oferta (aprovado em 2026-11-21): a sequência não pode terminar na pergunta da dor,
// porque ninguém responde a ela e a conversa morre (caso Abrakadabra).
export function textoApresentarDado(nome: string, tempo: string, recebido = "") {
  const dado = `Tenho um dado importante para te apresentar: meu primeiro contato com vocês foi há ${tempo}, e o sistema robotizado não me causou interesse em interagir com ele.`;
  const confusao = ACHOU_CLIENTE.test(recebido || "")
    ? (/festa/i.test(recebido) ? "Na verdade não estou organizando uma festa, desculpa a confusão 😊" : "Na verdade não sou cliente, desculpa a confusão 😊")
    : "";
  return [
    ...(confusao ? [`${saudacaoSP()}${nome ? `, ${nome}` : ""}! ${confusao}`, dado] : [`Olá, tudo bem${nome ? `, ${nome}` : ""}? ${dado}`]),
    "Já imaginou quantos clientes encontram vocês no Google, caem no WhatsApp de vocês e desistem de contratar por se depararem com um robô?",
    "Aqui na AW3S a gente resolve exatamente isso: um atendimento que conversa como gente, 24 horas, responde na hora e já agenda com a equipe de vocês. Posso te apresentar como funciona?",
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
  const angulo = (pend?.textos || []).find((t: string) => ANGULO.test(t || "")) || "";
  if (!pend || pend.erro) return false; // sem prospecção pendente, ou já pediu / já está na trilha Atende+
  const { data: travou } = await admin.from("prospeccao_pendente")
    .update({ erro: "pediu_pessoa", textos: [MARCADOR_ATENDE, angulo, MENSAGEM_PEDIR_PESSOA], imagens: [] })
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
export async function apresentarDado(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null, pend: { id: string; textos: string[]; erro?: string | null }, recebido = "") {
  if ((pend.textos || [])[0] !== MARCADOR_ATENDE || pend.erro !== "pediu_pessoa") return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: travou } = await admin.from("prospeccao_pendente").update({ erro: "apresentou" }).eq("id", pend.id).eq("erro", "pediu_pessoa").select("id");
  if (!travou?.length) return false;
  const { data: primeira } = await admin.from("mensagens").select("created_at").eq("company_id", companyId).eq("numero", numero)
    .eq("direcao", "saida").eq("autor", "prospeccao").order("created_at", { ascending: true }).limit(1).maybeSingle();
  const textos = textoApresentarDado(primeiroNome(contatoNome), tempoDesde(primeira?.created_at || new Date().toISOString()), recebido);
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
${apresentou ? `Essa mensagem já terminou oferecendo a solução ("Posso te apresentar como funciona?"). PRÓXIMO PASSO:
- Se a pessoa disse sim, quer saber mais ou perguntou como funciona: apresente-se formalmente (regra abaixo), explique a solução em poucas linhas e já proponha a reunião (passo 1 de COMO MARCAR A REUNIÃO).
- Se ela reagiu à dor ("é verdade", "perdemos sim", "o robô é só fora do horário"…): concorde ou acolha em UMA frase curta, sem discutir, e siga para a solução e a reunião do mesmo jeito.
- Se ela ainda achar que você é cliente, desfaça a confusão em uma frase e siga.
- Não repita o dado nem a pergunta da dor, e não pergunte de novo se pode apresentar. Nunca termine a conversa parada: toda resposta sua avança um passo rumo à reunião.\n` : ""}
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

${comoMarcar("Reunião AW3S: atendimento humanizado")}
${blocoAngulo([roteiro])}${roteiro.trim() && !ANGULO.test(roteiro) ? `\nRoteiro do Sérgio (siga este roteiro; ele vale mais que as regras gerais acima, menos a regra de não falar de site):\n"""\n${roteiro.trim()}\n"""` : ""}`;
}

// Ângulo do momento do nicho (máquina de vendas, 2026-11-21): vem no material da isca com o prefixo [ÂNGULO].
const ANGULO = /^\s*\[\s*[ÂA]NGULO\s*\]/i;
const materialSemAngulo = (textos?: string[]) => (textos || []).filter((t) => !ANGULO.test(t || "")).join("\n\n");
function blocoAngulo(textos?: string[]) {
  const a = (textos || []).find((t) => ANGULO.test(t || ""));
  return a ? `\n\nÂNGULO DO MOMENTO PARA ESTE NICHO (use com as suas palavras, no momento certo da conversa, para dar urgência e motivo ao convite):\n"""\n${a.replace(ANGULO, "").trim()}\n"""` : "";
}

// Passo a passo da reunião, comum às duas trilhas (Atende+ e site)
function comoMarcar(titulo: string, duracao = "Nossas reuniões são pelo Google Meet e levam no máximo 30 minutos.") {
  return `COMO MARCAR A REUNIÃO (siga esta ordem, uma etapa por mensagem):
1. Pergunte a preferência entre os DOIS PRÓXIMOS DIAS que têm horário na lista de HORÁRIOS LIVRES abaixo: "Você prefere hoje ou amanhã?" num dia útil; no fim de semana ou depois do expediente, use os dias da lista (ex.: "Você prefere segunda ou terça?"). Nunca ofereça um dia sem horário livre.
2. Consulte os HORÁRIOS LIVRES DE VERDADE (lista abaixo, quando houver) e sugira UM horário do dia escolhido ("Tenho às 15h, fica bom?"). Se não servir, ofereça outro da lista. Nunca invente horário fora da lista.
3. Quando a pessoa escolher, peça o e-mail dela para mandar o convite, e avise: "${duracao}"
4. Com o horário e o e-mail confirmados, diga só "Perfeito, vou marcar aqui 😊" e, na MESMA resposta, em uma nova linha, escreva exatamente:
   [AGENDAR: INÍCIO | FIM | ${titulo} | EMAIL]
   (INÍCIO = horário escolhido com -03:00, ex.: 2026-11-21T15:00:00-03:00; FIM = 30 min depois; EMAIL = o e-mail que a pessoa passou). Não diga que já está marcado: o sistema marca e manda a confirmação com o pedido para conferir se o convite chegou.
5. Quando a pessoa confirmar que o convite chegou, agradeça, diga que o Sérgio, nosso gerente de projetos, estará na reunião, deixe o site https://aw3s.com.br. NÃO use [HANDOFF] aqui: "o Sérgio estará na reunião" é só uma frase, você continua ativa nesta conversa para responder o que ele mandar depois (decisão do usuário, 2026-11-26). Se o convite não chegou, peça para olhar o spam e confirmar o e-mail.`;
}

// ---- Trilha "parceiro contador" (máquina de vendas, 2026-11-26) ----
// O escritório de contabilidade recebeu o e-mail da parceria por indicação, respondeu com interesse, recebeu o e-mail
// "como funciona" e tocou no botão do WhatsApp, que chega com a mensagem pronta:
//   "Olá, Katia! Sou do escritório X e quero agendar a conversa sobre a parceria AW3S."
// Ele NÃO é cliente de site: a Katia só marca a conversa de 15 min com o Sérgio (Google Meet) e tira dúvidas simples.
export const PARCEIRO_RE = /parceria\s+(?:da\s+|com\s+a\s+)?aw3s/i;
const nomeEscritorio = (t: string) => (t.match(/escrit[óo]rio\s+(.+?)\s+e\s+quero/i)?.[1] || "").trim().slice(0, 80) || null;
// Vale só na empresa que faz prospecção (a subconta da Katia) e por 14 dias desde a mensagem da parceria.
export async function detectarParceiro(companyId: string, numero: string, textoRecebido: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: prosp } = await admin.from("prospeccao_pendente").select("id").eq("company_id", companyId).limit(1);
  if (!prosp?.length) return null;
  if (PARCEIRO_RE.test(textoRecebido || "")) return { escritorio: nomeEscritorio(textoRecebido) };
  const desde = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data } = await admin.from("mensagens").select("texto").eq("company_id", companyId).eq("numero", numero)
    .eq("direcao", "entrada").ilike("texto", "%parceria%").gte("created_at", desde).order("created_at", { ascending: true }).limit(5);
  const m = ((data ?? []) as { texto: string }[]).find((x) => PARCEIRO_RE.test(x.texto || ""));
  return m ? { escritorio: nomeEscritorio(m.texto) } : null;
}
// Abertura FIXA da trilha de parceiro (usuário, 2026-11-26): no teste a IA mandou só 2 das 3 bolhas e chamou pelo
// nome do cadastro ("Erika"); a 3ª, com a iniciativa, só saiu depois que o parceiro respondeu. Agora sai sempre igual,
// sem IA, quando chega a mensagem do botão do e-mail (e não sai de novo se já saiu nas últimas 6 h).
export function aberturaParceiro(escritorio: string | null) {
  const doEsc = escritorio ? `do escritório ${escritorio}` : "do escritório";
  return [
    `Olá! Que bom falar com vocês ${doEsc} 😊`,
    "Eu sou a Katia, assistente da AW3S, e cuido da agenda do Sérgio.",
    "Vou te ajudar a encontrar o melhor horário para a nossa conversa sobre a parceria. Vocês têm preferência de dia ou horário? Me conta que eu consulto a agenda do Sérgio e já te sugiro as opções 📅",
  ];
}
export async function abrirParceiro(companyId: string, userId: string, instanceName: string, numero: string, contatoNome: string | null, escritorio: string | null, textoRecebido: string) {
  if (!PARCEIRO_RE.test(textoRecebido || "")) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const desde = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data } = await (supabaseAdmin as any).from("mensagens").select("id").eq("company_id", companyId).eq("numero", numero)
    .eq("direcao", "saida").ilike("texto", "%cuido da agenda do Sérgio%").gte("created_at", desde).limit(1);
  if (data?.length) return false;
  await enviarComoKatia(companyId, userId, instanceName, numero, contatoNome, aberturaParceiro(escritorio), "ia");
  return true;
}

export function instrucaoParceiro(escritorio: string | null) {
  const doEsc = escritorio ? `do escritório ${escritorio}` : "do escritório";
  const titulo = `Parceria AW3S: conversa com ${escritorio || "o escritório"}`;
  return `

## CONVERSA DE PARCERIA COM ESCRITÓRIO DE CONTABILIDADE (a regra mais importante desta conversa)
Quem está falando é ${escritorio ? `do escritório de contabilidade "${escritorio}"` : "de um escritório de contabilidade"}. O Sérgio, nosso gerente de projetos, mandou por e-mail o convite para a PARCERIA POR INDICAÇÃO da AW3S; o escritório respondeu com interesse, recebeu o e-mail de "como funciona" e tocou no botão para falar com você e AGENDAR uma conversa com o Sérgio.
É o começo de uma parceria, e o parceiro está AVALIANDO o nosso atendimento em cada mensagem: um detalhe frio ou uma conversa parada pode fazer ele desistir. Por isso:

### QUEM CONDUZ É VOCÊ, O TEMPO TODO
- Você toma TODAS as iniciativas, com empolgação e simpatia. Nunca espere o parceiro puxar o próximo passo.
- O parceiro precisa saber SEMPRE o que vai acontecer agora. Toda mensagem sua termina com uma pergunta fácil OU anunciando o que você está fazendo ("deixa eu olhar a agenda do Sérgio…", "só um minutinho, estou marcando…").
- Nunca termine numa frase solta, sem pergunta e sem próximo passo.
- Resposta curta dele ("certo", "ok", "pode ser", "sim", emoji) é a sua deixa para avançar NA HORA, com calor humano.

### TOM
- Cordial, simpática, acolhedora e animada: o escritório é um parceiro que a AW3S está feliz em receber. Faça ele se sentir importante.
- Mensagens curtas (1 a 2 frases por bolha), linguagem simples, no máximo um emoji leve por bolha (😊 🤝 📅 🙌).
- NOME: NÃO use o nome do cadastro do WhatsApp nem o "Contato" do resumo (o número pode estar salvo com outro nome). Fale com "vocês ${doEsc}" até a pessoa dizer o próprio nome; se disser, use o nome dela.
- Gênero neutro ("fique à vontade", não "fique tranquila/tranquilo").
- NÃO ofereça site, prévia, prints nem atendente; NUNCA use o marcador [MOSTRAR_PREVIA]; não pergunte se a agenda dele está aberta a novos clientes.

### ROTEIRO (siga a ordem; use as frases de exemplo com naturalidade, adaptando ao que ele disser)
1. PRIMEIRA RESPOSTA (o sistema já manda sozinho estas 3 bolhas quando chega a mensagem do botão; se você vir que já foram enviadas, NÃO repita: siga do passo 2), em 3 bolhas (separe com |||):
   "Olá! Que bom falar com vocês ${doEsc} 😊" ||| "Eu sou a Katia, assistente da AW3S, e cuido da agenda do Sérgio." ||| "Vou te ajudar a encontrar o melhor horário para a nossa conversa sobre a parceria. Vocês têm preferência de dia ou horário? Me conta que eu consulto a agenda do Sérgio e já te sugiro as opções 📅"
2. QUANDO ELE RESPONDER (qualquer resposta, até "certo"): acolha e mostre que está agindo. Ex.: "Que bom ter vocês aqui! Deixa eu dar uma olhadinha na agenda do Sérgio 😊" ||| e já ofereça, com entusiasmo, UM horário real da lista de HORÁRIOS LIVRES que combine com a preferência dele (ou o mais próximo, se ele não tiver preferência): "Olha que bom: temos um horário livre hoje às 14h! Posso confirmar para você?". Se o dia que ele pediu não tiver horário, diga com leveza e ofereça a melhor alternativa. Nunca invente horário fora da lista.
3. QUANDO ELE CONFIRMAR O HORÁRIO: "Perfeito! 🙌" ||| "Nossa conversa é pelo Google Meet e tem duração de 15 minutos, que é o padrão do nosso sistema, mas temos uma margem de segurança para atender vocês com calma e tirar todas as dúvidas sobre a parceria." ||| "Para eu te enviar o convite, qual é o seu melhor e-mail?"
4. QUANDO ELE PASSAR O E-MAIL: agradeça e avise que está marcando, e na MESMA resposta, numa nova linha, escreva o marcador:
   "Obrigada! Só um minutinho, estou acessando a agenda do Sérgio para marcar a nossa reunião 📅"
   [AGENDAR: INÍCIO | FIM | ${titulo} | EMAIL]
   (INÍCIO = horário escolhido com -03:00, ex.: 2026-11-26T14:00:00-03:00; FIM = 30 min depois; EMAIL = o e-mail que ele passou). Não diga que já está marcado: o sistema marca e manda sozinho a confirmação ("Prontinho! Reunião marcada…") pedindo para conferir se o convite chegou.
5. QUANDO ELE CONFIRMAR QUE O CONVITE CHEGOU ou AGRADECER: "Por nada! Nós da AW3S é que agradecemos o contato de vocês, e desejamos que essa parceria traga muitos bons negócios para os dois lados 🤝" ||| "O Sérgio, nosso gerente de projetos, conduz daqui pra frente. Se quiser conhecer um pouco mais da AW3S antes da conversa: https://aw3s.com.br" ||| "Tenha um ótimo dia!". NÃO use [HANDOFF] aqui: "o Sérgio conduz daqui pra frente" é só uma frase; você continua ativa nesta conversa e responde com a mesma simpatia o que ele mandar depois (dúvidas, remarcar, agradecimentos). Se o convite NÃO chegou: peça para olhar o spam e confirmar o e-mail, com calma, e ofereça reenviar.

### DÚVIDAS NO MEIO DO CAMINHO
- O que você PODE dizer (só isto, sem inventar): o escritório indica clientes que precisam de site, atendimento com IA no WhatsApp, sistema ou aplicativo; a AW3S conversa, apresenta a proposta, implanta e dá suporte, e o escritório não precisa vender nem acompanhar nada; a comissão é de 20% da implantação e 5% de cada mensalidade enquanto o cliente continuar, ou 10% nos projetos sob medida, paga por Pix até o dia 10 do mês seguinte ao pagamento do cliente; o parceiro recebe um código, o selo "Parceiro AW3S", um aplicativo próprio para indicar e acompanhar indicações e comissões, e um manual com os serviços.
- Acolha a dúvida em uma frase, responda curto e, na MESMA resposta, volte ao passo do roteiro em que vocês estão.
- Contrato, termo, valores dos planos, impostos ou casos específicos: "Ótima pergunta! O Sérgio explica tudo isso com calma na conversa 😊" e volte ao roteiro. NUNCA informe preço de planos nem prometa resultado.
- Se ele pedir para falar depois, combine o melhor dia e ofereça horários desse dia. Se disser claramente que não quer, agradeça com carinho, deixe https://aw3s.com.br e encerre. Se pedir uma pessoa agora ou reclamar, passe para o Sérgio com [HANDOFF: parceiro pediu atendimento].
- Se perguntarem se você é um robô, não negue: diga com simpatia que é a assistente virtual da AW3S e que a conversa é com o Sérgio.`;
}

// Trilha do site (usuário, 2026-11-21): os prints são só uma prévia; o site completo o Sérgio apresenta na reunião.
const REUNIAO_SITE = `REUNIÃO PARA APRESENTAR O SITE COMPLETO (o objetivo desta conversa):
- Deixe sempre claro que os prints são uma PRÉVIA, e que o site completo é apresentado numa reunião curta com o Sérgio, nosso gerente de projetos. Nela ele mostra o site completo e dá todos os detalhes do serviço (ajustes, como funciona, valores).
- Ex.: "Esses prints são só uma prévia 😊 Para te apresentar o site completo, a gente marca uma conversa rápida com o Sérgio, nosso gerente de projetos. Ele te mostra tudo e tira todas as dúvidas. Você prefere hoje ou amanhã?"
- Não ofereça mais "responder SIM para receber a versão completa" nem mande link: o site completo é mostrado na reunião.
- Preço, prazo, pagamento, domínio, hospedagem ou "quero fechar": diga com leveza que o Sérgio mostra tudo isso na reunião e siga para marcar. NUNCA informe valores.
${comoMarcar("Reunião AW3S: apresentação do site")}`;

// Postura de vendedora ativa (usuário, 2026-11-21): a Katia estava engessada, esperando o cliente se manifestar
// (caso Abrakadabra). Vale em TODA conversa de prospecção e passa por cima do método genérico de atendimento.
export const POSTURA_VENDEDORA = `

## SUA POSTURA: VENDEDORA ATIVA (a regra mais importante desta conversa)
Você NÃO é uma atendente esperando perguntas. Você é uma vendedora ativa da AW3S, com autonomia: foi você quem procurou este cliente, e é você quem conduz a conversa do começo ao fim. O seu objetivo é levar o cliente até uma reunião curta pelo Google Meet com o Sérgio, nosso gerente de projetos.
Nesta conversa, o "MÉTODO DE ATENDIMENTO" genérico (esperar o cliente, entender tudo antes de oferecer, só falar do serviço quando perguntarem) NÃO vale. Valem estas regras:
- A iniciativa é sempre sua. Não espere o cliente se manifestar para apresentar a solução, mostrar o valor e fazer o convite.
- Toda resposta sua termina com um GANCHO: uma pergunta fácil de responder ou um convite claro ("Posso te mostrar?", "Faz sentido para vocês?", "Você prefere hoje ou amanhã?"). Nunca termine numa afirmação solta.
- Uma pergunta retórica ou de dor ("já imaginou quantos clientes…?") vem sempre acompanhada, na mesma resposta, da solução e do convite. Nunca deixe a dor sozinha esperando resposta.
- Resposta curta do cliente ("ok", "entendi", "legal", "hum", emoji, "vou ver") não encerra a conversa: é a sua deixa para dar o próximo passo.
- Objeção faz parte da venda: acolha em uma frase, responda com um benefício concreto e volte ao convite para a reunião.
- Cada mensagem sua avança um passo nesta rota: dor ou oportunidade → solução → convite para a reunião → dia → horário livre → e-mail → convite enviado. Na conversa da prévia de site, o caminho passa antes pela prévia, e a reunião é para apresentar o site completo.
- Ativa não é insistente: simpática, confiante, leve e curta, uma ideia por mensagem, sem pressão. Se a pessoa disser claramente que não tem interesse, agradeça, deixe o site https://aw3s.com.br e encerre.`;

export function instrucaoIsca(p: { textos: string[]; erro?: string | null; status?: string }) {
  return POSTURA_VENDEDORA + instrucaoIscaBase(p);
}

function instrucaoIscaBase(p: { textos: string[]; erro?: string | null; status?: string }) {
  if ((p.textos || [])[0] === MARCADOR_ATENDE) return instrucaoAtende(p.textos[1] || "", p.textos[2] || "", p.erro === "apresentou");
  if (p.status === "entregue") return `

## Prospecção: os prints do site JÁ foram enviados para este contato
O time da AW3S criou um modelo inicial de site para a empresa dele, e os prints já foram enviados nesta conversa, seguidos de: ${TEXTO_DEPOIS_RESUMO}. Ou seja, você já perguntou o que ele achou e já ofereceu desenvolver o site todo.
Material REAL desta prospecção (use à vontade, com as suas palavras; não invente nada além disso):
"""
${materialSemAngulo(p.textos)}
"""${blocoAngulo(p.textos)}
Como conduzir agora:
- Reaja ao que ele disse sobre a prévia (elogio, dúvida ou crítica), curto e como uma pessoa, e na MESMA resposta convide para a reunião de apresentação do site completo. Não reenvie os prints e NÃO use o marcador [MOSTRAR_PREVIA].
- Responda dúvidas e objeções com calma, sempre voltando ao convite para a reunião.
- Se ele pedir para falar com uma pessoa agora ou reclamar de algo, passe para o Sérgio. Se não tiver interesse, agradeça, deixe o site https://aw3s.com.br e não insista.

${REUNIAO_SITE}`;
  return `

## Prospecção: há uma prévia de site pronta para este contato
Você (ou a empresa) mandou a mensagem de abertura para este contato, e ele respondeu. O time da AW3S já criou um modelo exclusivo de site para a empresa dele, e os prints estão prontos para enviar.
Material REAL desta prospecção (use à vontade, com as suas palavras; não invente nada além disso):
"""
${materialSemAngulo(p.textos)}
"""${blocoAngulo(p.textos)}
Como conduzir:
- ATENÇÃO: o contato ainda NÃO recebeu nenhuma imagem. A abertura foi só: "Bom dia, tudo bem com você? Aqui é a Katia, encontrei vocês no Google. Como está a agenda de vocês? Estão abertos a novos clientes?" (ou, 3 dias depois, "Vocês ainda estão aceitando novos clientes?"). Não pergunte se ele "viu a demonstração/prévia" nem fale de imagens "acima" ou "que mandei".
- O contato pode achar que você é uma CLIENTE querendo agendar ou fazer orçamento. NUNCA finja ser cliente, não peça horário, preço nem serviço. Já na sua PRIMEIRA resposta, agradeça o retorno e conte com transparência e leveza por que perguntou, ligando com o que ele respondeu. Tom acolhedor, de quem quer ver a empresa crescer e ganhar mais dinheiro, nunca de vendedor insistente. Exemplo (siga esta forma): se disse que está aberto a clientes → "Que bom! 😊 Te perguntei porque eu ajudo empresas aqui da região a atrair mais clientes pelo Google. Vi que a [empresa] tem ótimas avaliações e está fazendo um trabalho excelente no seu segmento. Posso te ajudar a fortalecer ainda mais a autoridade de vocês e trazer muito mais clientes?". Use a nota e o número de avaliações reais do material quando houver. Quando ele topar, conte que você já montou um rascunho de site para a empresa e mostre ([MOSTRAR_PREVIA]). Se disse que a agenda está cheia → elogie e diga que um site ajuda a selecionar melhores clientes e valorizar o preço. Se perguntou "o que você precisa?" → explique sem rodeio que não é para agendar, é uma ideia para trazer mais clientes. Peça desculpas pela confusão se ele parecer frustrado.
- Se quem respondeu for funcionário(a) ou secretária, seja simpática, diga em 1 ou 2 frases quem você é e por que escreveu, e ofereça mostrar a prévia para ele(a) repassar ao responsável.
- Converse de forma natural e curta, como uma pessoa. Responda dúvidas e objeções com calma ("quem é você?", "quanto custa?", "não tenho tempo", "já tenho site"…), sempre puxando para mostrar a prévia: é ela que gera o interesse.
- Quando o contato topar ver, mostrar curiosidade ou for o momento natural, escreva uma frase curta apresentando a prévia e coloque no FINAL da resposta o marcador [MOSTRAR_PREVIA]. O sistema envia os prints do site logo depois da sua mensagem. Use o marcador uma única vez e não diga que "vai enviar imagens" sem usá-lo.
- Na mensagem que leva o [MOSTRAR_PREVIA], só apresente a prévia em uma frase curta; NÃO pergunte o que ele achou. Logo depois dos prints o sistema manda sozinho: ${TEXTO_DEPOIS_RESUMO}.
- Quando ele responder sobre a prévia, reaja ao que ele disse (elogio, dúvida ou crítica) e convide para a reunião de apresentação do site completo.
- Se ele disser que não tem interesse, agradeça com educação, deixe o site https://aw3s.com.br e não insista.

${REUNIAO_SITE}`;
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
    // Depois dos prints a Katia puxa a conversa (usuário, 2026-11-20): o cliente fica esperando uma definição.
    // Texto fixo, sem IA, ~3 s depois da última imagem.
    try {
      await new Promise((r) => setTimeout(r, 2500 + Math.floor(Math.random() * 1500)));
      await enviarComoKatia(companyId, userId, instanceName, numero, contatoNome, TEXTO_DEPOIS_DOS_PRINTS, "ia");
    } catch (e: any) { console.error("[isca] seguimento depois dos prints", e?.message); }
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
