import { createHmac } from "node:crypto";

// Atrás do Traefik, request.url chega como http:// (proxy termina o TLS e
// encaminha em HTTP puro pro container) — usar isso direto pra montar o
// redirect_uri quebra a troca do código OAuth com o Google (redirect_uri_mismatch).
// Os headers X-Forwarded-* refletem o que o navegador realmente usou.
export function getPublicOrigin(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || new URL(req.url).host;
  return `${proto}://${host}`;
}

export function signState(payload: string) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "fallback";
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}.${sig}`;
}

export function verifyState(state: string): { companyId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "fallback";
  const expected = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj.companyId) return null;
    return { companyId: obj.companyId as string };
  } catch {
    return null;
  }
}

// Cria evento no Google Agenda usando os tokens armazenados da empresa.
// Refresca o access_token se expirou. Insere também na tabela agendamento.
export async function createCalendarEventForCompany(
  admin: any,
  companyId: string,
  data: { titulo: string; inicio: string; fim: string; descricao?: string; cardId?: string | null },
) {
  const { data: gi } = await admin.from("google_integration").select("*").eq("company_id", companyId).maybeSingle();
  if (!gi?.conectado) throw new Error("Google Agenda não conectado");

  let accessToken = gi.access_token as string;
  if (gi.expiry && new Date(gi.expiry).getTime() < Date.now() + 60_000 && gi.refresh_token) {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        refresh_token: gi.refresh_token as string,
        grant_type: "refresh_token",
      }),
    });
    const tok = await tokRes.json();
    if (tok.access_token) {
      accessToken = tok.access_token;
      await admin.from("google_integration").update({
        access_token: accessToken,
        expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      }).eq("company_id", companyId);
    }
  }

  const calendarId = gi.calendar_id || "primary";

  // Confere conflito de horário antes de criar (evita agendar em cima de outro evento).
  const fbRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: data.inicio, timeMax: data.fim, items: [{ id: calendarId }] }),
  });
  if (fbRes.ok) {
    const fb = await fbRes.json();
    const busy = fb?.calendars?.[calendarId]?.busy;
    if (Array.isArray(busy) && busy.length > 0) throw new Error("SLOT_OCUPADO");
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  // Gera link do Google Meet automaticamente para reuniões online
  url.searchParams.set("conferenceDataVersion", "1");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: data.titulo,
      description: data.descricao || "",
      start: { dateTime: data.inicio, timeZone: "America/Sao_Paulo" },
      end: { dateTime: data.fim, timeZone: "America/Sao_Paulo" },
      reminders: { useDefault: true },
      conferenceData: {
        createRequest: {
          requestId: `az-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Google API: ${res.status} ${await res.text()}`);
  const ev = await res.json();
  const meetLink: string | null =
    ev?.hangoutLink ||
    ev?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri ||
    null;

  await admin.from("agendamento").insert({
    company_id: companyId,
    card_id: data.cardId ?? null,
    titulo: data.titulo,
    inicio: data.inicio,
    fim: data.fim,
    google_event_id: ev.id,
    status: "agendado",
  });
  return { eventId: ev.id as string, meetLink, htmlLink: (ev.htmlLink as string) ?? null };
}
