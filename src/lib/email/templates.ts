// Templates de e-mail com a cara do Atende+Empresas, usados pelo hook de
// autenticação (src/routes/api/public/auth-email-hook.ts) no lugar dos
// e-mails genéricos que o Supabase Auth enviaria por padrão.

const BRAND_NAME = "Atende+Empresas";
const BRAND_GREEN = "#22C55E";
const BRAND_GREEN_DARK = "#15924A";
const LOGO_URL = "https://atendemaisempresas.com.br/logo-mascot.svg";

function shell(title: string, bodyHtml: string) {
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charSet="utf-8" /><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" style="background:#f4f6f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellPadding="0" cellSpacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:480px;width:100%;">
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND_GREEN},${BRAND_GREEN_DARK});padding:28px 32px;text-align:center;">
              <img src="${LOGO_URL}" width="40" height="40" alt="${BRAND_NAME}" style="border-radius:10px;vertical-align:middle;" />
              <span style="color:#fff;font-size:20px;font-weight:800;vertical-align:middle;margin-left:10px;">${BRAND_NAME}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#f9fafb;text-align:center;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">Você recebeu este e-mail porque uma ação foi solicitada na sua conta ${BRAND_NAME}. Se não foi você, pode ignorar.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function button(label: string, url: string) {
  return `<a href="${url}" style="display:inline-block;background:linear-gradient(135deg,${BRAND_GREEN},${BRAND_GREEN_DARK});color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;">${label}</a>`;
}

export type EmailKind = "signup" | "recovery" | "magiclink" | "invite" | "email_change";

export function renderAuthEmail(kind: EmailKind, verifyUrl: string): { subject: string; html: string } {
  switch (kind) {
    case "signup":
      return {
        subject: `Confirme seu cadastro — ${BRAND_NAME}`,
        html: shell("Confirme seu cadastro", `
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Falta pouco pra ativar sua IA 🚀</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Confirme seu e-mail pra ativar sua conta no ${BRAND_NAME} e começar a atender seus clientes no WhatsApp com IA.</p>
          <p style="text-align:center;margin:0 0 24px;">${button("Confirmar meu e-mail", verifyUrl)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">Se o botão não funcionar, copie e cole este link no navegador:<br/><span style="word-break:break-all;">${verifyUrl}</span></p>
        `),
      };
    case "recovery":
      return {
        subject: `Redefinir sua senha — ${BRAND_NAME}`,
        html: shell("Redefinir senha", `
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Vamos redefinir sua senha</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Recebemos um pedido pra redefinir a senha da sua conta no ${BRAND_NAME}. Clique no botão abaixo pra criar uma nova senha.</p>
          <p style="text-align:center;margin:0 0 24px;">${button("Redefinir senha", verifyUrl)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">Se você não pediu isso, pode ignorar este e-mail com segurança.<br/>Link: <span style="word-break:break-all;">${verifyUrl}</span></p>
        `),
      };
    case "magiclink":
      return {
        subject: `Seu link de acesso — ${BRAND_NAME}`,
        html: shell("Link de acesso", `
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Seu link de acesso chegou</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Clique no botão abaixo pra entrar direto na sua conta ${BRAND_NAME}, sem precisar digitar senha.</p>
          <p style="text-align:center;margin:0 0 24px;">${button("Entrar agora", verifyUrl)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">Link: <span style="word-break:break-all;">${verifyUrl}</span></p>
        `),
      };
    case "invite":
      return {
        subject: `Você foi convidado — ${BRAND_NAME}`,
        html: shell("Convite", `
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Você foi convidado pro ${BRAND_NAME}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Clique no botão abaixo pra aceitar o convite e definir sua senha de acesso.</p>
          <p style="text-align:center;margin:0 0 24px;">${button("Aceitar convite", verifyUrl)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">Link: <span style="word-break:break-all;">${verifyUrl}</span></p>
        `),
      };
    case "email_change":
      return {
        subject: `Confirme seu novo e-mail — ${BRAND_NAME}`,
        html: shell("Confirmar novo e-mail", `
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Confirme seu novo e-mail</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Pediram a troca do e-mail da sua conta ${BRAND_NAME}. Confirme clicando abaixo.</p>
          <p style="text-align:center;margin:0 0 24px;">${button("Confirmar novo e-mail", verifyUrl)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">Link: <span style="word-break:break-all;">${verifyUrl}</span></p>
        `),
      };
  }
}

// E-mail de boas-vindas mandado na hora do cadastro (ver
// src/lib/signup.functions.ts). `loginUrl` aqui é o action_link real de
// confirmação do Supabase (admin.generateLink), não um link fixo — a conta
// só fica liberada depois que a pessoa clica nesse botão: até lá,
// signInWithPassword falha porque o e-mail ainda não foi confirmado.
export function renderWelcomeEmail(opts: { nome: string | null; email: string; password: string; loginUrl: string }): { subject: string; html: string } {
  const primeiroNome = opts.nome?.trim().split(/\s+/)[0] || null;
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}! 🎉` : "Oi! 🎉";
  return {
    subject: `Confirme sua conta — ${BRAND_NAME}`,
    html: shell("Bem-vindo", `
      <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">${saudacao}</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">Sua conta no ${BRAND_NAME} está quase pronta. Guarde os dados de acesso abaixo e confirme seu e-mail pra liberar a entrada:</p>
      <table role="presentation" width="100%" cellPadding="0" cellSpacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;margin:0 0 24px;">
        <tr>
          <td style="padding:18px 20px;">
            <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">Seus dados de acesso</p>
            <p style="margin:0 0 8px;font-size:14.5px;color:#111827;"><b>E-mail:</b> <span style="font-family:monospace;">${opts.email}</span></p>
            <p style="margin:0;font-size:14.5px;color:#111827;"><b>Senha:</b> <span style="font-family:monospace;">${opts.password}</span></p>
          </td>
        </tr>
      </table>
      <p style="text-align:center;margin:0 0 20px;">${button("Confirmar e-mail e entrar", opts.loginUrl)}</p>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:#6b7280;">Sem confirmar o e-mail, o login com a senha acima não funciona ainda. Depois de entrar, se quiser, você pode trocar essa senha em <b>Configurações → Segurança</b>.</p>
    `),
  };
}

// Segundo e-mail pós-compra, pedindo pra marcar o onboarding com um
// especialista — mandado logo depois de renderWelcomeEmail em
// provisionCompanyFromPurchase (src/routes/api/public/billing/webhook.ts).
export function renderScheduleReminderEmail(opts: { nome: string | null; loginUrl: string }): { subject: string; html: string } {
  const primeiroNome = opts.nome?.trim().split(/\s+/)[0] || null;
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : "Oi!";
  return {
    subject: `Vamos marcar seu onboarding? — ${BRAND_NAME}`,
    html: shell("Marque seu onboarding", `
      <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">${saudacao} Falta um passo importante 📅</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Pra sua IA já sair no ar treinada certinho com o seu negócio, um especialista do nosso time faz o setup junto com você numa call rápida.</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Entre na sua conta e escolha um horário que funcione pra você — leva menos de 1 minuto.</p>
      <p style="text-align:center;margin:0 0 20px;">${button("Marcar meu onboarding", opts.loginUrl)}</p>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:#6b7280;">Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp do suporte.</p>
    `),
  };
}

// Aviso pro cliente quando o monitor (src/lib/whatsapp-monitor.server.ts)
// detecta que o WhatsApp dele caiu e o agente parou de responder.
export function renderWhatsappDisconnectedEmail(opts: { nome: string | null; numero: string | null; conexaoUrl: string }): { subject: string; html: string } {
  const primeiroNome = opts.nome?.trim().split(/\s+/)[0] || null;
  const saudacao = primeiroNome ? `Oi, ${primeiroNome}!` : "Oi!";
  const numeroTxt = opts.numero ? ` (<b>${opts.numero}</b>)` : "";
  return {
    subject: `⚠️ Seu WhatsApp desconectou — ${BRAND_NAME}`,
    html: shell("WhatsApp desconectado", `
      <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">${saudacao} Seu WhatsApp desconectou ⚠️</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">O número conectado ao ${BRAND_NAME}${numeroTxt} perdeu a conexão. Enquanto ele estiver desconectado, <b>sua IA não consegue responder seus clientes</b>.</p>
      <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#374151;">Pra voltar, leva menos de 2 minutos:</p>
      <ol style="margin:0 0 24px;padding-left:20px;font-size:14.5px;line-height:1.7;color:#374151;">
        <li>Clique no botão abaixo e gere um novo QR Code</li>
        <li>No celular, abra o WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b></li>
        <li>Escaneie o código</li>
      </ol>
      <p style="text-align:center;margin:0 0 20px;">${button("Reconectar meu WhatsApp", opts.conexaoUrl)}</p>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:#6b7280;">Isso costuma acontecer quando o celular fica muitos dias sem internet ou quando o aparelho é removido em "Aparelhos conectados". Qualquer dúvida, chame o suporte.</p>
    `),
  };
}

// E-mail de alerta interno pro dono da plataforma — sem a casca de marca,
// só um aviso direto quando um cliente novo compra, agenda o onboarding
// ou tem o WhatsApp desconectado.
export function renderInternalAlertEmail(opts: {
  tipo: "compra" | "agendamento" | "desconexao";
  empresa: string;
  contatoNome: string | null;
  contatoEmail: string;
  detalhe?: string;
}): { subject: string; html: string } {
  const titulo =
    opts.tipo === "compra" ? "🛒 Nova compra"
    : opts.tipo === "agendamento" ? "📅 Novo agendamento de onboarding"
    : "⚠️ WhatsApp desconectado";
  return {
    subject: `${titulo} — ${opts.empresa}`,
    html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f5;padding:24px;">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 14px;font-size:18px;color:#111827;">${titulo}</h2>
        <p style="margin:0 0 6px;font-size:14px;color:#374151;"><b>Empresa:</b> ${opts.empresa}</p>
        <p style="margin:0 0 6px;font-size:14px;color:#374151;"><b>Contato:</b> ${opts.contatoNome || "—"}</p>
        <p style="margin:0 0 6px;font-size:14px;color:#374151;"><b>E-mail:</b> ${opts.contatoEmail}</p>
        ${opts.detalhe ? `<p style="margin:10px 0 0;font-size:14px;color:#374151;">${opts.detalhe}</p>` : ""}
      </div>
    </body></html>`,
  };
}
