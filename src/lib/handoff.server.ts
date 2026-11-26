// Handoff com aviso (agent_config.handoff_aviso): quando a IA marca [HANDOFF: motivo],
// o contato é pausado de forma persistente e o responsável (agent_config.telefone_transferencia)
// recebe, pelo próprio número da empresa, o resumo da conversa para assumir.
// O cliente continua falando no mesmo número; o responsável responde pelo Atende+ (Conversas)
// ou pelo celular onde esse número está conectado.

export function soDigitosTelefone(t?: string | null): string {
  let d = String(t || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d; // DDD + número sem o 55
  return d;
}

export function mesmoTelefone(a?: string | null, b?: string | null): boolean {
  const x = soDigitosTelefone(a), y = soDigitosTelefone(b);
  if (!x || !y) return false;
  // Celular com e sem o 9 extra (o WhatsApp às vezes entrega sem ele)
  const semNove = (n: string) => (n.length === 13 && n.startsWith("55") ? n.slice(0, 4) + n.slice(5) : n);
  return x === y || semNove(x) === semNove(y);
}

type Msg = { autor?: string; direcao: string; texto: string };

export async function notificarHandoff(params: {
  admin: any;
  instanceName: string;
  companyId: string;
  userId: string;
  cfg: any;
  numero: string;
  nomeContato?: string | null;
  motivo: string;
  etapa?: string | null;
  historico: Msg[]; // em ordem cronológica, já com a última resposta da IA
  ia?: { provider: string; model: string; openaiKey?: string; anthropicKey?: string };
}) {
  const { admin, instanceName, companyId, userId, cfg, numero, nomeContato, motivo, etapa, historico } = params;
  const destino = soDigitosTelefone(cfg?.telefone_transferencia);

  // 1. Pausa persistente: a IA não responde mais este contato até alguém despausar.
  await admin
    .from("contact_pause")
    .upsert({ company_id: companyId, user_id: userId, numero, pausado: true }, { onConflict: "company_id,numero" });

  if (!destino) {
    console.warn("[handoff] sem telefone_transferencia; contato pausado sem aviso", companyId, numero);
    return;
  }

  // 2. Resumo curto feito pela IA (se falhar, vai só com as últimas mensagens)
  const linhas = historico.slice(-30).map((m) => `${m.direcao === "entrada" ? "Cliente" : "Atendente"}: ${m.texto}`);
  let resumo = "";
  try {
    const { lovableAiChat } = await import("@/lib/lovable-ai.server");
    resumo = (await lovableAiChat(
      [
        {
          role: "system",
          content:
            "Você resume conversas de WhatsApp para um vendedor que vai assumir o atendimento agora. " +
            "Responda em português, no máximo 6 linhas curtas, sem saudação, neste formato:\n" +
            "Quem é: ...\nO que quer: ...\nObjeções ou dúvidas: ...\nO que já foi dito/prometido: ...\nPróximo passo sugerido: ...",
        },
        { role: "user", content: linhas.join("\n") },
      ],
      params.ia || "google/gemini-flash-lite-latest",
    )).trim();
  } catch (e: any) {
    console.error("[handoff resumo]", e?.message);
  }

  const ultimas = historico
    .slice(-6)
    .map((m) => `${m.direcao === "entrada" ? "👤" : "🤖"} ${m.texto.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");

  const texto = [
    `🔔 *Assumir conversa* (${cfg?.nome_agente || "IA"})`,
    `*Cliente:* ${nomeContato || "sem nome"} · +${numero}`,
    `*Motivo:* ${motivo}`,
    etapa ? `*Etapa:* ${etapa}` : "",
    resumo ? `\n*Resumo:*\n${resumo}` : "",
    `\n*Últimas mensagens:*\n${ultimas}`,
    `\nA IA parou de responder este contato. Continue a conversa pelo Atende+ (Conversas) ou pelo celular deste número. Não responda pelo seu número pessoal.`,
  ]
    .filter(Boolean)
    .join("\n");

  // 3. Envia pelo próprio número da empresa para o responsável
  try {
    const { evoSendText } = await import("@/lib/evolution.server");
    await evoSendText(instanceName, destino, texto);
  } catch (e: any) {
    console.error("[handoff aviso]", e?.message);
  }

  // 4. Evento para integrações (ex.: máquina de vendas)
  try {
    const { emitWebhook } = await import("@/lib/webhooks.server");
    void emitWebhook(companyId, "lead.handoff", { numero, contato_nome: nomeContato ?? null, motivo, etapa: etapa ?? null, resumo });
  } catch {}
}

// Aviso de reunião marcada (2026-11-24): o evento nasce na agenda do próprio responsável, e o Google
// não manda e-mail para o dono da agenda — no teste real ninguém da AW3S ficou sabendo. Agora o
// responsável (telefone_transferencia) recebe no WhatsApp, pelo número da empresa, os dados da reunião.
// Não pausa o contato: a IA segue atendendo normalmente.
export async function notificarAgendamento(params: {
  instanceName: string;
  companyId: string;
  cfg: any;
  numero: string;
  nomeContato?: string | null;
  quando: string;
  titulo: string;
  email?: string | null;
  meetLink?: string | null;
  primeiraMensagem?: string | null;
  historico: Msg[];
}) {
  const destino = soDigitosTelefone(params.cfg?.telefone_transferencia);
  if (!destino) return;
  if (mesmoTelefone(destino, params.numero)) return; // o próprio responsável marcando: não avisa a si mesmo

  let resumo = "";
  try {
    const { lovableAiChat } = await import("@/lib/lovable-ai.server");
    const linhas = params.historico.slice(-30).map((m) => `${m.direcao === "entrada" ? "Cliente" : "Atendente"}: ${m.texto}`);
    resumo = (await lovableAiChat(
      [
        {
          role: "system",
          content:
            "Você prepara um vendedor para uma reunião marcada pelo WhatsApp. Responda em português, no máximo 4 linhas curtas, " +
            "sem saudação, neste formato:\nNegócio: ...\nComo atende hoje / dor: ...\nO que quer: ...\nObservações: ...",
        },
        { role: "user", content: linhas.join("\n") },
      ],
      "google/gemini-flash-lite-latest",
    )).trim();
  } catch (e: any) {
    console.error("[agendamento resumo]", e?.message);
  }

  const texto = [
    `📅 *Reunião marcada* (${params.cfg?.nome_agente || "IA"})`,
    `*Quando:* ${params.quando}`,
    `*Cliente:* ${params.nomeContato || "sem nome"} · +${params.numero}`,
    params.email ? `*E-mail:* ${params.email}` : "",
    params.meetLink ? `*Meet:* ${params.meetLink}` : "",
    params.primeiraMensagem ? `*Chegou com:* "${params.primeiraMensagem.replace(/\s+/g, " ").slice(0, 160)}"` : "",
    `*Assunto:* ${params.titulo}`,
    resumo ? `\n*Resumo:*\n${resumo}` : "",
    `\nO evento já está na sua Google Agenda. A IA continua atendendo este contato.`,
  ].filter(Boolean).join("\n");

  try {
    const { evoSendText } = await import("@/lib/evolution.server");
    await evoSendText(params.instanceName, destino, texto);
  } catch (e: any) {
    console.error("[agendamento aviso]", e?.message);
  }
}

// Aviso de consumo da IA (usuário, 2026-11-26): a proposta comercial promete aviso antes de acabar o limite.
// Cada resposta da IA consome 1 crédito. Avisa o responsável (telefone_transferencia) UMA vez quando sobra 20% da
// franquia do mês (80% usado) e quando o saldo zera. Pacote extra: +1.000 respostas por R$ 49, ou mudança de plano.
export async function avisarConsumoCreditos(params: { instanceName: string; companyId: string; cfg: any }) {
  try {
    const destino = soDigitosTelefone(params.cfg?.telefone_transferencia);
    if (!destino) return;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;
    const [{ data: comp }, { data: sub }] = await Promise.all([
      admin.from("company").select("creditos_saldo, creditos_resetam_em").eq("id", params.companyId).maybeSingle(),
      admin.from("subscription").select("plan:plan(creditos_mensais, nome)").eq("company_id", params.companyId)
        .in("status", ["active", "trialing", "past_due"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const saldo = Number(comp?.creditos_saldo ?? -1);
    const mensais = Number(sub?.plan?.creditos_mensais ?? 0);
    const marco80 = mensais > 0 ? Math.floor(mensais * 0.2) : -1;
    if (saldo !== 0 && saldo !== marco80) return;
    const renova = comp?.creditos_resetam_em ? new Date(comp.creditos_resetam_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;
    const contato = "Fale com a AW3S para um pacote extra (+1.000 respostas por R$ 49) ou para mudar de plano: https://wa.me/5511994786204";
    const texto = saldo === 0
      ? [`🚨 *A IA atingiu o limite de respostas do mês*`, mensais ? `Foram usadas as ${mensais.toLocaleString("pt-BR")} respostas do plano.` : "", `A partir de agora a IA não responde novas mensagens${renova ? ` até a renovação em ${renova}` : " até a renovação"}.`, contato].filter(Boolean).join("\n")
      : [`⚠️ *A IA já usou 80% das respostas do mês*`, `Restam ${saldo.toLocaleString("pt-BR")} de ${mensais.toLocaleString("pt-BR")} respostas${renova ? ` (renova em ${renova})` : ""}.`, `Para o atendimento não parar, ${contato.charAt(0).toLowerCase()}${contato.slice(1)}`].join("\n");
    const { evoSendText } = await import("@/lib/evolution.server");
    await evoSendText(params.instanceName, destino, texto);
    console.log(`[creditos] aviso ${saldo === 0 ? "limite" : "80%"} para ${params.companyId}`);
  } catch (e: any) {
    console.error("[creditos aviso]", e?.message);
  }
}
