import { createHmac } from "node:crypto";
import { fetchWithTimeout } from "./fetch-with-timeout";

const GOOGLE_TIMEOUT_MS = 15000;

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

// Mesmo HMAC de verifyState, mas pro fluxo de conexão do Google "master"
// (dono da plataforma) — não carrega companyId, só confirma que o state
// não foi adulterado.
export function verifyMasterState(state: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "fallback";
  const expected = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return sig === expected;
}

// Lê/refresca o access_token do Google conectado em app_config (conta
// pessoal do dono da plataforma — não confundir com google_integration,
// que é por empresa/cliente).
export async function getMasterGoogleAccessToken(admin: any): Promise<string | null> {
  const { data: cfg } = await admin.from("app_config").select("*").eq("id", true).maybeSingle();
  if (!cfg?.google_conectado || !cfg.google_access_token) return null;

  if (cfg.google_expiry && new Date(cfg.google_expiry).getTime() < Date.now() + 60_000 && cfg.google_refresh_token) {
    const tokRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        refresh_token: cfg.google_refresh_token as string,
        grant_type: "refresh_token",
      }),
    }, GOOGLE_TIMEOUT_MS);
    const tok = await tokRes.json();
    if (tok.access_token) {
      await admin.from("app_config").update({
        google_access_token: tok.access_token,
        google_expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      }).eq("id", true);
      return tok.access_token as string;
    }
    return null;
  }
  return cfg.google_access_token as string;
}

// Cria evento na Google Agenda do dono da plataforma (app_config), com
// checagem de freeBusy e link de Meet — usado pelo agendamento de onboarding
// com especialista (src/lib/specialist-booking.functions.ts).
export async function createMasterCalendarEvent(
  admin: any,
  data: { titulo: string; inicio: string; fim: string; descricao?: string },
): Promise<{ eventId: string; meetLink: string | null }> {
  const accessToken = await getMasterGoogleAccessToken(admin);
  if (!accessToken) throw new Error("Google não conectado");

  const { data: cfg } = await admin.from("app_config").select("google_calendar_id").eq("id", true).maybeSingle();
  const calendarId = cfg?.google_calendar_id || "primary";

  const fbRes = await fetchWithTimeout("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: data.inicio, timeMax: data.fim, items: [{ id: calendarId }] }),
  }, GOOGLE_TIMEOUT_MS);
  if (fbRes.ok) {
    const fb = await fbRes.json();
    const busy = fb?.calendars?.[calendarId]?.busy;
    if (Array.isArray(busy) && busy.length > 0) throw new Error("SLOT_OCUPADO");
  }

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("conferenceDataVersion", "1");
  const res = await fetchWithTimeout(url.toString(), {
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
          requestId: `az-onb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  }, GOOGLE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Google API: ${res.status} ${await res.text()}`);
  const ev = await res.json();
  const meetLink: string | null =
    ev?.hangoutLink ||
    ev?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri ||
    null;
  return { eventId: ev.id as string, meetLink };
}

// Adiciona uma linha na planilha de agendamentos do dono da plataforma.
export async function appendToMasterSpreadsheet(admin: any, row: string[]): Promise<void> {
  const accessToken = await getMasterGoogleAccessToken(admin);
  if (!accessToken) return;
  const { data: cfg } = await admin.from("app_config").select("google_spreadsheet_id").eq("id", true).maybeSingle();
  const spreadsheetId = cfg?.google_spreadsheet_id;
  if (!spreadsheetId) return;
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Agendamentos!A:F:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
    GOOGLE_TIMEOUT_MS,
  );
}

// Aba de controle de usuários na mesma planilha do dono da plataforma —
// uma linha por conta criada, com uma coluna "Status" que começa como
// "Usuário novo" e é atualizada pra "Plano Starter/Pro/Business" assim que
// a pessoa escolhe um plano no checkout (ver src/lib/signup.functions.ts e
// src/lib/checkout.functions.ts). Cria a aba sozinha se ainda não existir
// (planilhas criadas antes dessa funcionalidade só tinham "Agendamentos").
const USERS_SHEET = "Usuários";
const USERS_SHEET_HEADERS = ["Data/Hora", "Nome", "E-mail", "Status"];

async function ensureUsersSheetTab(accessToken: string, spreadsheetId: string): Promise<void> {
  const metaRes = await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    GOOGLE_TIMEOUT_MS,
  );
  if (!metaRes.ok) return;
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some((s: any) => s.properties?.title === USERS_SHEET);
  if (exists) return;

  await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: USERS_SHEET } } }] }),
  }, GOOGLE_TIMEOUT_MS);
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(USERS_SHEET)}!A1:D1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [USERS_SHEET_HEADERS] }),
    },
    GOOGLE_TIMEOUT_MS,
  );
}

async function getMasterSpreadsheetId(admin: any): Promise<{ accessToken: string; spreadsheetId: string } | null> {
  const accessToken = await getMasterGoogleAccessToken(admin);
  if (!accessToken) return null;
  const { data: cfg } = await admin.from("app_config").select("google_spreadsheet_id").eq("id", true).maybeSingle();
  const spreadsheetId = cfg?.google_spreadsheet_id;
  if (!spreadsheetId) return null;
  return { accessToken, spreadsheetId };
}

// Chamada na criação da conta (trial) — ver createTrialAccount.
export async function appendNewUserToMasterSheet(admin: any, data: { email: string; nome: string | null }): Promise<void> {
  const ctx = await getMasterSpreadsheetId(admin);
  if (!ctx) return;
  await ensureUsersSheetTab(ctx.accessToken, ctx.spreadsheetId);
  const row = [
    new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    data.nome || "—",
    data.email,
    "Usuário novo",
  ];
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(USERS_SHEET)}!A:D:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
    GOOGLE_TIMEOUT_MS,
  );
}

// Chamada quando a pessoa escolhe um plano no checkout (createCheckoutCompany)
// — acha a linha dela pelo e-mail (a mais recente, se houver duplicatas) e
// atualiza só a coluna Status. Se não achar (conta criada antes dessa
// funcionalidade existir), insere uma linha nova em vez de falhar.
export async function updateUserPlanInMasterSheet(admin: any, data: { email: string; planoNome: string }): Promise<void> {
  const ctx = await getMasterSpreadsheetId(admin);
  if (!ctx) return;
  await ensureUsersSheetTab(ctx.accessToken, ctx.spreadsheetId);

  const status = `Plano ${data.planoNome}`;
  const getRes = await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(USERS_SHEET)}!A:D`,
    { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
    GOOGLE_TIMEOUT_MS,
  );
  const rows: string[][] = getRes.ok ? (await getRes.json()).values || [] : [];

  let rowIndex = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    if ((rows[i][2] || "").trim().toLowerCase() === data.email.trim().toLowerCase()) {
      rowIndex = i;
      break;
    }
  }

  if (rowIndex === -1) {
    const row = [new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }), "—", data.email, status];
    await fetchWithTimeout(
      `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(USERS_SHEET)}!A:D:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [row] }),
      },
      GOOGLE_TIMEOUT_MS,
    );
    return;
  }

  const range = `${USERS_SHEET}!D${rowIndex + 1}`;
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ctx.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[status]] }),
    },
    GOOGLE_TIMEOUT_MS,
  );
}

// Cria evento no Google Agenda usando os tokens armazenados da empresa.
// Refresca o access_token se expirou. Insere também na tabela agendamento.
// convidado (máquina de vendas, 2026-11-20): e-mail do cliente → entra como participante e o Google manda o convite (sendUpdates=all)
export async function createCalendarEventForCompany(
  admin: any,
  companyId: string,
  data: { titulo: string; inicio: string; fim: string; descricao?: string; cardId?: string | null; convidado?: string | null },
) {
  const { accessToken, calendarId } = await acessoGoogleEmpresa(admin, companyId);
  return criarEventoComToken(admin, companyId, accessToken, calendarId, data);
}

// Token de acesso da Google Agenda da empresa (renova se expirou)
export async function acessoGoogleEmpresa(admin: any, companyId: string): Promise<{ accessToken: string; calendarId: string }> {
  const { data: gi } = await admin.from("google_integration").select("*").eq("company_id", companyId).maybeSingle();
  if (!gi?.conectado) throw new Error("Google Agenda não conectado");

  let accessToken = gi.access_token as string;
  if (gi.expiry && new Date(gi.expiry).getTime() < Date.now() + 60_000 && gi.refresh_token) {
    const tokRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        refresh_token: gi.refresh_token as string,
        grant_type: "refresh_token",
      }),
    }, GOOGLE_TIMEOUT_MS);
    const tok = await tokRes.json();
    if (tok.access_token) {
      accessToken = tok.access_token;
      await admin.from("google_integration").update({
        access_token: accessToken,
        expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      }).eq("company_id", companyId);
    }
  }

  return { accessToken, calendarId: gi.calendar_id || "primary" };
}

// Horários livres da agenda da empresa: blocos de `duracaoMin` dentro da janela (dias da semana + faixa de horas),
// nos próximos `dias` dias corridos, a partir de agora + antecedência, tirando o que já está ocupado (freeBusy).
export async function horariosLivresEmpresa(
  admin: any,
  companyId: string,
  opts: { dias?: Set<number> | null; horaIni?: number | null; horaFim?: number | null; porDia?: Map<number, [number, number]> | null; duracaoMin?: number; antecedenciaMin?: number; quantosDias?: number },
): Promise<Array<{ inicio: string; fim: string; dia: string; hora: string }>> {
  const { accessToken, calendarId } = await acessoGoogleEmpresa(admin, companyId);
  const dur = (opts.duracaoMin || 30) * 60_000;
  const ini = opts.horaIni ?? 9, fim = opts.horaFim ?? 18;
  const agora = Date.now() + (opts.antecedenciaMin ?? 60) * 60_000;
  const quantos = opts.quantosDias ?? 2;
  // meia-noite de hoje em São Paulo (-03:00, sem horário de verão)
  const hojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const base = new Date(`${hojeSP}T00:00:00-03:00`).getTime();
  const fimBusca = base + (quantos + 7) * 864e5;
  const fbRes = await fetchWithTimeout("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: new Date(base).toISOString(), timeMax: new Date(fimBusca).toISOString(), timeZone: "America/Sao_Paulo", items: [{ id: calendarId }] }),
  }, GOOGLE_TIMEOUT_MS);
  if (!fbRes.ok) throw new Error(`Google freeBusy: ${fbRes.status}`);
  const busy: Array<{ start: string; end: string }> = (await fbRes.json())?.calendars?.[calendarId]?.busy || [];
  const ocupado = (a: number, b: number) => busy.some((x) => new Date(x.start).getTime() < b && new Date(x.end).getTime() > a);
  const livres: Array<{ inicio: string; fim: string; dia: string; hora: string }> = [];
  let diasComJanela = 0;
  for (let d = 0; d < quantos + 7 && diasComJanela < quantos; d++) {
    const dia0 = base + d * 864e5;
    const semana = new Date(dia0 + 12 * 3600_000).getUTCDay(); // meio-dia SP ≈ 15h UTC: mesmo dia da semana
    if (opts.dias && !opts.dias.has(semana)) continue;
    diasComJanela++;
    const [hIni, hFim] = opts.porDia?.get(semana) ?? [ini, fim]; // faixa própria do dia (ex.: sábado só de manhã)
    for (let t = dia0 + hIni * 3600_000; t + dur <= dia0 + hFim * 3600_000; t += dur) {
      if (t < agora || ocupado(t, t + dur)) continue;
      const iso = (ms: number) => new Date(ms - 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "-03:00");
      livres.push({
        inicio: iso(t), fim: iso(t + dur),
        dia: new Date(t).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" }),
        hora: new Date(t).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }),
      });
    }
  }
  return livres;
}

// Detalhes de um evento (link do Meet, convidados) para a tela de Reuniões da máquina de vendas
export async function detalhesEventoEmpresa(admin: any, companyId: string, eventId: string) {
  const { accessToken, calendarId } = await acessoGoogleEmpresa(admin, companyId);
  const res = await fetchWithTimeout(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, GOOGLE_TIMEOUT_MS);
  if (!res.ok) return null;
  const ev = await res.json();
  return {
    meet: ev?.hangoutLink || ev?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri || null,
    convidados: (ev?.attendees || []).filter((a: any) => !a.self).map((a: any) => ({ email: a.email, resposta: a.responseStatus })),
    status: ev?.status || null, link: ev?.htmlLink || null, descricao: ev?.description || "",
  };
}

async function criarEventoComToken(
  admin: any, companyId: string, accessToken: string, calendarId: string,
  data: { titulo: string; inicio: string; fim: string; descricao?: string; cardId?: string | null; convidado?: string | null },
) {
  // Confere conflito de horário antes de criar (evita agendar em cima de outro evento).
  const fbRes = await fetchWithTimeout("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: data.inicio, timeMax: data.fim, items: [{ id: calendarId }] }),
  }, GOOGLE_TIMEOUT_MS);
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
  const convidado = String(data.convidado || "").trim().toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(convidado);
  if (emailOk) url.searchParams.set("sendUpdates", "all"); // o Google manda o convite por e-mail
  const res = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: data.titulo,
      description: data.descricao || "",
      start: { dateTime: data.inicio, timeZone: "America/Sao_Paulo" },
      end: { dateTime: data.fim, timeZone: "America/Sao_Paulo" },
      ...(emailOk ? { attendees: [{ email: convidado }] } : {}),
      reminders: { useDefault: true },
      conferenceData: {
        createRequest: {
          requestId: `az-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  }, GOOGLE_TIMEOUT_MS);
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
  return { eventId: ev.id as string, meetLink, htmlLink: (ev.htmlLink as string) ?? null, convidado: emailOk ? convidado : null };
}
