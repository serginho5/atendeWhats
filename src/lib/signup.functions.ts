import { createServerFn } from "@tanstack/react-start";
import { renderWelcomeEmail } from "@/lib/email/templates";
import { sendEmail } from "@/lib/email/send";
import { appendNewUserToMasterSheet } from "@/lib/google.server";

function generatePassword(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 14) + "Aa1!";
}

// Cria a conta já com senha definida por nós (não pelo usuário) e manda um
// único e-mail com e-mail+senha de acesso e o link de confirmação. A conta
// fica sem confirmar até esse link ser clicado: enquanto isso,
// signInWithPassword falha, então o acesso continua bloqueado (ver
// src/routes/entrar.tsx). Usamos admin.generateLink em vez do signUp() do
// cliente porque generateLink nunca dispara o Send Email Hook do Supabase
// (src/routes/api/public/auth-email-hook.ts) — assim mandamos só este
// e-mail, com a senha, sem duplicar com o e-mail genérico de confirmação.
export const createTrialAccount = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string; plano?: string }) => {
    const email = String(d.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("E-mail inválido");
    const plano = d.plano ? String(d.plano).toLowerCase().trim() : undefined;
    return { email, plano };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const password = generatePassword();
    const siteUrl = process.env.SITE_URL || "https://atendemaisempresas.com.br";
    const redirectTo = `${siteUrl}/entrar${data.plano ? `?plano=${encodeURIComponent(data.plano)}` : ""}`;

    const { data: linkData, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "signup",
      email: data.email,
      password,
      options: { redirectTo },
    });
    if (error || !linkData?.properties?.action_link) {
      const msg = (error?.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        throw new Error("Já existe uma conta com esse e-mail.");
      }
      throw new Error(error?.message || "Falha ao criar conta");
    }

    const { subject, html } = renderWelcomeEmail({
      nome: null,
      email: data.email,
      password,
      loginUrl: linkData.properties.action_link,
    });
    await sendEmail(data.email, subject, html);

    try {
      await appendNewUserToMasterSheet(supabaseAdmin, { email: data.email, nome: null });
    } catch (e: any) {
      console.error("[signup] falha ao registrar novo usuário na planilha:", e?.message || e);
    }

    return { ok: true as const };
  });
