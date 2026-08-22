import { createFileRoute } from "@tanstack/react-router";
import { verifySupabaseWebhook } from "@/lib/email/verify-webhook";
import { renderAuthEmail, type EmailKind } from "@/lib/email/templates";
import { sendEmail } from "@/lib/email/send";

// Supabase Auth "Send Email Hook": em vez do Supabase mandar o e-mail de
// confirmação/recuperação de senha com o template genérico dele, ele chama
// esta rota com os dados do link — nós montamos o e-mail com a cara do
// Atende+Empresas e mandamos via Resend.
// Configurar em: Supabase Dashboard > Authentication > Hooks > Send Email Hook
export const Route = createFileRoute("/api/public/auth-email-hook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const secret = process.env.SUPABASE_AUTH_HOOK_SECRET;
        if (!secret) {
          console.error("[auth-email-hook] SUPABASE_AUTH_HOOK_SECRET não configurada");
          return Response.json({ error: "not configured" }, { status: 500 });
        }

        const ok = verifySupabaseWebhook(rawBody, {
          id: request.headers.get("webhook-id"),
          timestamp: request.headers.get("webhook-timestamp"),
          signature: request.headers.get("webhook-signature"),
        }, secret);
        if (!ok) return Response.json({ error: "assinatura inválida" }, { status: 401 });

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "payload inválido" }, { status: 400 });
        }

        const email: string | undefined = payload?.user?.email;
        const data = payload?.email_data ?? {};
        const actionType: string = data.email_action_type;
        const tokenHash: string = data.token_hash;
        const redirectTo: string = data.redirect_to || "";
        const siteUrl: string = data.site_url || process.env.SUPABASE_URL || "";

        if (!email || !tokenHash || !actionType) {
          return Response.json({ error: "dados insuficientes" }, { status: 400 });
        }

        const kindMap: Record<string, EmailKind> = {
          signup: "signup",
          recovery: "recovery",
          magiclink: "magiclink",
          invite: "invite",
          email_change: "email_change",
          email_change_current: "email_change",
          email_change_new: "email_change",
        };
        const kind = kindMap[actionType];
        if (!kind) {
          console.error("[auth-email-hook] tipo de evento desconhecido:", actionType);
          return Response.json({ error: "tipo desconhecido" }, { status: 400 });
        }

        const supabaseUrl = process.env.SUPABASE_URL || siteUrl;
        const verifyUrl = new URL(`${supabaseUrl}/auth/v1/verify`);
        verifyUrl.searchParams.set("token", tokenHash);
        verifyUrl.searchParams.set("type", actionType);
        if (redirectTo) verifyUrl.searchParams.set("redirect_to", redirectTo);

        const { subject, html } = renderAuthEmail(kind, verifyUrl.toString());

        try {
          await sendEmail(email, subject, html);
        } catch (e: any) {
          console.error("[auth-email-hook] falha ao enviar via Resend:", e?.message || e);
          return Response.json({ error: "falha ao enviar e-mail" }, { status: 500 });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
