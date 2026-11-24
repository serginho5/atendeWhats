// Roteador de especialistas (2026-11-24).
// O agente principal (ex.: Sofia) é uma pessoa só para o cliente. A cada mensagem, um classificador rápido
// escolhe o especialista do assunto e o webhook junta as instruções e o conhecimento dele ao prompt.
// Tudo aqui é tolerante a falha: sem tabela, sem especialistas ou com erro do classificador, o agente
// responde como sempre respondeu (ou mantém o especialista que já estava na conversa).

export interface Especialista {
  id: string;
  nome: string;
  quando_usar: string;
  instrucoes: string;
  conhecimento: string;
  passar_para_humano: boolean;
}

export const GERAL = "geral";

export async function carregarEspecialistas(admin: any, companyId: string): Promise<Especialista[]> {
  try {
    const { data, error } = await admin
      .from("agent_specialist")
      .select("id, nome, quando_usar, instrucoes, conhecimento, passar_para_humano")
      .eq("company_id", companyId)
      .eq("ativo", true)
      .order("ordem", { ascending: true });
    if (error) return []; // tabela ainda não criada no banco: segue sem especialistas
    return (data ?? []) as Especialista[];
  } catch {
    return [];
  }
}

// Escolhe o especialista do assunto. Retorna o nome escolhido ou GERAL.
export async function rotearEspecialista(p: {
  especialistas: Especialista[];
  atual: string | null;
  historico: Array<{ direcao: string; texto: string }>;
  texto: string;
}): Promise<string> {
  const { especialistas, atual } = p;
  if (!especialistas.length) return GERAL;
  const atualValido = atual && especialistas.some((e) => e.nome === atual) ? atual : null;

  const opcoes = [
    `0 = ${GERAL}: conversa que não se encaixa em nenhum assunto abaixo (cumprimento, conversa solta, assunto novo sem relação)`,
    ...especialistas.map((e, i) => `${i + 1} = ${e.nome}: ${e.quando_usar || "(sem descrição)"}`),
  ].join("\n");
  const recentes = p.historico.slice(-6)
    .map((m) => `${m.direcao === "entrada" ? "Cliente" : "Atendente"}: ${(m.texto || "").slice(0, 300)}`)
    .join("\n");

  const system =
    "Você é um roteador de atendimento. Escolha qual especialista deve responder a ÚLTIMA mensagem do cliente, " +
    "considerando o assunto da conversa. Se o assunto não mudou, mantenha o especialista atual. " +
    "Responda APENAS com o número da opção, sem mais nada.";
  const user =
    `OPÇÕES:\n${opcoes}\n\nESPECIALISTA ATUAL: ${atualValido ?? GERAL}\n\nCONVERSA RECENTE:\n${recentes || "(início da conversa)"}\n\n` +
    `ÚLTIMA MENSAGEM DO CLIENTE:\n${p.texto.slice(0, 600)}\n\nNúmero da opção:`;

  try {
    const { lovableAiChat } = await import("@/lib/lovable-ai.server");
    const raw = await lovableAiChat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      "google/gemini-flash-lite-latest",
    );
    const n = Number(String(raw).match(/\d+/)?.[0] ?? NaN);
    if (n === 0) return GERAL;
    if (Number.isInteger(n) && n >= 1 && n <= especialistas.length) return especialistas[n - 1].nome;
  } catch (e: any) {
    console.error("[especialistas] roteador falhou:", e?.message);
  }
  return atualValido ?? GERAL; // na dúvida, não troca de assunto
}

// Bloco de prompt do especialista escolhido
export function blocoEspecialista(e: Especialista, handoffAtivo: boolean): string {
  const semInfo = e.passar_para_humano && handoffAtivo
    ? `Se a resposta não estiver nas instruções ou no conhecimento abaixo, NÃO invente: diga que vai chamar o responsável para continuar aqui mesmo e use o marcador [HANDOFF: ${e.nome} — motivo].`
    : `Se a resposta não estiver nas instruções ou no conhecimento abaixo, NÃO invente: diga com naturalidade que vai confirmar com a equipe e retorna.`;
  return `

## ASSUNTO DESTA MENSAGEM: ${e.nome.toUpperCase()}
Você continua sendo a mesma pessoa, com o mesmo nome e o mesmo jeito; só o assunto mudou. Não anuncie troca de setor nem diga que "vai transferir para o ${e.nome}".
${e.instrucoes ? `\nCOMO AGIR NESTE ASSUNTO (vale mais que as regras gerais acima quando houver conflito):\n${e.instrucoes}\n` : ""}${e.conhecimento ? `\nCONHECIMENTO DESTE ASSUNTO (use só isto como fonte; não invente nada além):\n"""\n${e.conhecimento}\n"""\n` : ""}
${semInfo}`;
}

// Guarda o assunto da conversa e registra a troca (best-effort)
export async function registrarEspecialista(admin: any, companyId: string, numero: string, de: string | null, para: string, mensagem: string) {
  if ((de ?? GERAL) === para) return;
  try {
    await admin.from("crm_cards").update({ especialista_atual: para }).eq("company_id", companyId).eq("numero", numero);
    await admin.from("specialist_route_log").insert({ company_id: companyId, numero, de: de ?? GERAL, para, mensagem: mensagem.slice(0, 500) });
  } catch (e: any) {
    console.error("[especialistas] registro falhou:", e?.message);
  }
}
