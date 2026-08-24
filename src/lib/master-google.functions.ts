import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertSuper(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Acesso negado");
}

async function buildOrigin() {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { getPublicOrigin } = await import("@/lib/google.server");
  const req = getRequest();
  return getPublicOrigin(req);
}

// Conexão Google do dono da plataforma (Agenda + Planilhas) — usada pro
// agendamento de onboarding com especialista. Não confundir com
// startGoogleOAuth em src/lib/google.functions.ts, que é por cliente/empresa.
export const startMasterGoogleOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context.supabase, context.userId);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
      return { ok: false as const, error: "Google OAuth não configurado (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)." };
    }
    const origin = await buildOrigin();
    const redirectUri = `${origin}/api/public/google-callback-master`;
    const payload = Buffer.from(JSON.stringify({ master: true, t: Date.now() })).toString("base64url");
    const { signState } = await import("@/lib/google.server");
    const state = signState(payload);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email",
    );
    url.searchParams.set("state", state);
    return { ok: true as const, url: url.toString() };
  });

export const disconnectMasterGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("app_config").upsert({
      id: true,
      google_conectado: false,
      google_access_token: null,
      google_refresh_token: null,
      google_expiry: null,
      google_email: null,
    });
    return { ok: true };
  });

export const getMasterGoogleStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("app_config")
      .select("google_conectado, google_email, google_spreadsheet_id")
      .eq("id", true)
      .maybeSingle();
    return {
      conectado: !!data?.google_conectado,
      email: data?.google_email ?? null,
      spreadsheetId: data?.google_spreadsheet_id ?? null,
    };
  });
