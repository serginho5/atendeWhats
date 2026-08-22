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
