// Envia e-mails transacionais via Resend (nunca pelo Supabase — o Send Email
// Hook em src/routes/api/public/auth-email-hook.ts intercepta e substitui os
// e-mails de auth padrão do Supabase por estes, com a marca do sistema).

const FROM = "Atende+Empresas <nao-responda@atendemaisempresas.com.br>";

export async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY não configurada");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
  return res.json();
}
