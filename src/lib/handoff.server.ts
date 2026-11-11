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
