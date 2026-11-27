// Ligação da Sofia com a gestão interna da AW3S (gestao.aw3s.com.br), 2026-11-27.
// Quando o roteador escolhe o especialista de PROJETOS, a Sofia consulta a gestão pelo telefone do contato
// e recebe a situação real do projeto (etapa, prazo, chamados). Ela só passa informação para o responsável
// ou um contato autorizado, e nunca fala de financeiro. Também pode abrir um chamado com o marcador
// [CHAMADO: código do projeto | tipo | pedido].
// Configuração no .env do servidor: GESTAO_URL e GESTAO_SOFIA_TOKEN (o SOFIA_TOKEN da gestão).
// Tudo é tolerante a falha: sem configuração ou com a gestão fora do ar, a Sofia diz que vai confirmar com a equipe.

const URL_GESTAO = (process.env.GESTAO_URL || "").replace(/\/$/, "");
const TOKEN = process.env.GESTAO_SOFIA_TOKEN || "";
export const gestaoConfigurada = () => !!(URL_GESTAO && TOKEN);

/** O especialista que fala de projetos (nome contém "projeto"). */
export const ehEspecialistaProjetos = (nome: string | null | undefined) => !!nome && /projeto/i.test(nome);

async function chamar(metodo: "GET" | "POST", caminho: string, corpo?: unknown): Promise<any | null> {
  if (!gestaoConfigurada()) return null;
  try {
    const r = await fetch(`${URL_GESTAO}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return await r.json().catch(() => null);
  } catch (e: any) {
    console.error("[gestao]", e?.message);
    return null;
  }
}

export async function consultarGestao(numero: string) {
  return chamar("GET", `/api/sofia?telefone=${encodeURIComponent(numero)}`);
}

/** Bloco de prompt com a situação real vinda da gestão. */
export function blocoGestao(r: any): string {
  if (!r) {
    return `\n\nDADOS DO PROJETO: a consulta ao sistema de projetos não respondeu agora. NÃO invente etapa nem prazo: diga que vai confirmar com a equipe e retorna.`;
  }
  if (!r.reconhecido) {
    return `\n\nDADOS DO PROJETO: este número NÃO é o responsável nem um contato autorizado de nenhum cliente. ${r.orientacao || ""}
Não passe NENHUMA informação de projeto, prazo ou pedido. Peça, com educação, que o responsável pelo cadastro entre em contato, ou que mande uma autorização dizendo que esta pessoa vai conduzir o projeto daqui em diante. Não abra chamado.`;
  }
  const clientes = (r.clientes || []).map((c: any) => {
    const projetos = (c.projetos || []).map((p: any) => `  - ${p.codigo} (${p.tipo}): etapa "${p.etapa}"${p.aguardandoCliente ? " · aguardando algo do cliente" : ""}\n    Resposta sugerida: ${p.resposta}`).join("\n");
    const chamados = (c.chamados || []).length
      ? (c.chamados || []).map((ch: any) => `  - Pedido #${ch.numero}: "${ch.pedido}" · ${ch.prazo}\n    Resposta sugerida: ${ch.resposta}`).join("\n")
      : "  (nenhum pedido em aberto)";
    return `CLIENTE ${c.codigo} · ${c.empresa} · falando com ${c.falandoCom?.nome} (${c.falandoCom?.papel})\nProjetos:\n${projetos || "  (nenhum)"}\nPedidos em aberto:\n${chamados}`;
  }).join("\n\n");
  return `

DADOS DO PROJETO (fonte: sistema de gestão da AW3S, consultado agora; use SÓ isto, não invente etapa, prazo ou data):
${clientes}

REGRAS DESTE ASSUNTO:
- ${r.regras || "Fale só das etapas e dos pedidos. Nunca fale de financeiro."}
- Use as "respostas sugeridas" como base, com o seu jeito; pode resumir. Não leia códigos internos (AW-0000) para o cliente, a não ser o número do pedido.
- Se perguntarem de pagamento, valor, mensalidade, boleto ou Pix: diga que isso é com o financeiro e que vai avisar o Sérgio, e use [HANDOFF: financeiro — pergunta sobre pagamento].
- Se o cliente PEDIR UMA ALTERAÇÃO, correção ou suporte (ex.: trocar foto, telefone, texto, algo que não funciona), confirme o que ele quer em uma frase e inclua no FINAL da resposta o marcador:
  [CHAMADO: CÓDIGO DO PROJETO | alteracao ou suporte | descrição curta e clara do pedido]
  Se for página nova, função nova ou algo que não existe no projeto, use o tipo "orcamento" e diga que a equipe vai preparar um orçamento.
  Use o marcador só uma vez por pedido. O sistema registra e manda a confirmação com o número e o prazo; não invente número nem prazo.`;
}

export const MARCADOR_CHAMADO = /\[CHAMADO:\s*([^\]|]*)\|\s*([^\]|]*)\|\s*([^\]]+)\]/gi;

/** Tira os marcadores [CHAMADO: ...] da resposta e abre os chamados na gestão. Devolve o texto limpo e as confirmações. */
export async function processarChamados(texto: string, numero: string): Promise<{ texto: string; confirmacoes: string[] }> {
  const pedidos = [...texto.matchAll(MARCADOR_CHAMADO)].map((m) => ({ projeto: m[1].trim(), tipo: m[2].trim().toLowerCase(), descricao: m[3].trim() }));
  const limpo = texto.replace(MARCADOR_CHAMADO, "").replace(/\s{2,}/g, " ").trim();
  const confirmacoes: string[] = [];
  for (const p of pedidos.slice(0, 2)) {
    const r = await chamar("POST", "/api/sofia", { telefone: numero, projeto: p.projeto, tipo: p.tipo, descricao: p.descricao });
    if (r?.ok) {
      confirmacoes.push(r.orcamento
        ? `Registrei seu pedido como nº ${r.numero}. Como é algo novo, a equipe vai preparar um orçamento e te retorna por aqui.`
        : `Pedido registrado: nº ${r.numero}. O prazo é até ${r.prazoTexto} (3 dias úteis). Assim que ficar pronto, te aviso por aqui.`);
    } else {
      console.error("[gestao chamado]", r?.erro || "sem resposta");
      confirmacoes.push("Anotei o seu pedido e vou passar agora para a equipe. Assim que tiver o número e o prazo, te retorno por aqui.");
    }
  }
  return { texto: limpo, confirmacoes };
}
