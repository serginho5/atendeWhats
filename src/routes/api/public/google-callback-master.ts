import { createFileRoute } from "@tanstack/react-router";
import { verifyMasterState, getPublicOrigin } from "@/lib/google.server";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

const SHEET_HEADERS = ["Data/Hora", "Empresa", "Contato", "E-mail", "Telefone", "Plano"];

async function ensureSpreadsheet(accessToken: string): Promise<string> {
  const createRes = await fetchWithTimeout("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Atende+Empresas — Agendamentos de Onboarding" },
      sheets: [{ properties: { title: "Agendamentos" } }],
    }),
  }, 15000);
  if (!createRes.ok) throw new Error(`Falha ao criar planilha: ${createRes.status} ${await createRes.text()}`);
  const sheet = await createRes.json();
  const spreadsheetId = sheet.spreadsheetId as string;

  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Agendamentos!A1:F1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    },
    15000,
  );

  return spreadsheetId;
}

export const Route = createFileRoute("/api/public/google-callback-master")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return new Response("missing params", { status: 400 });
        if (!verifyMasterState(state)) return new Response("invalid state", { status: 400 });

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!clientId || !clientSecret) return new Response("oauth not configured", { status: 500 });

        const redirectUri = `${getPublicOrigin(request)}/api/public/google-callback-master`;
        const tokRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, grant_type: "authorization_code",
          }),
        }, 15000);
        const tok = await tokRes.json();
        if (!tok.access_token) {
          return new Response(`token exchange failed: ${JSON.stringify(tok)}`, { status: 400 });
        }

        let email: string | null = null;
        try {
          const infoRes = await fetchWithTimeout("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tok.access_token}` },
          }, 15000);
          const info = await infoRes.json();
          email = info?.email ?? null;
        } catch {}

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: existing } = await (supabaseAdmin as any)
          .from("app_config")
          .select("google_spreadsheet_id")
          .eq("id", true)
          .maybeSingle();

        let spreadsheetId = existing?.google_spreadsheet_id ?? null;
        let sheetError: string | null = null;
        if (!spreadsheetId) {
          try {
            spreadsheetId = await ensureSpreadsheet(tok.access_token);
          } catch (e: any) {
            sheetError = e?.message || String(e);
            console.error("[google-callback-master] falha ao criar planilha:", sheetError);
          }
        }

        await (supabaseAdmin as any).from("app_config").upsert({
          id: true,
          google_email: email,
          google_access_token: tok.access_token,
          google_refresh_token: tok.refresh_token ?? null,
          google_expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
          google_calendar_id: "primary",
          google_spreadsheet_id: spreadsheetId,
          google_conectado: true,
        });

        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Google conectado</title>
<body style="font-family:system-ui;background:#081410;color:#e5f3ea;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:24px">
<h1>✅ Google conectado${email ? ` (${email})` : ""}</h1>
<p>${sheetError ? "Conta conectada, mas houve um erro ao criar a planilha — verifique nos logs." : "Planilha de agendamentos criada no seu Drive."}</p>
<p>Pode fechar esta aba.</p>
<script>setTimeout(()=>{window.close();location.href="/master/configuracoes"},1800)</script>
</div></body>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    },
  },
});
