import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Agendamento de onboarding com especialista — dias úteis, 9h–17h, blocos de
// 30 min, fuso America/Sao_Paulo. O Brasil não observa horário de verão desde
// 2019, então o offset -03:00 é fixo (sem precisar de lib de timezone).
const SLOT_MINUTES = 30;
const START_HOUR = 9;
const END_HOUR = 17;
const BUSINESS_DAYS_AHEAD = 10;
const TZ_OFFSET = "-03:00";

type Slot = { start: string; end: string; label: string };
type Day = { date: string; label: string; slots: Slot[] };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// "Agora" com os campos de data lidos como se fossem horário de São Paulo
// (UTC-3): subtrai 3h do instante real e lê os campos UTC do resultado.
function nowInSaoPaulo(): { y: number; m: number; d: number; weekday: number } {
  const spInstant = new Date(Date.now() - 3 * 3600 * 1000);
  return {
    y: spInstant.getUTCFullYear(),
    m: spInstant.getUTCMonth() + 1,
    d: spInstant.getUTCDate(),
    weekday: spInstant.getUTCDay(),
  };
}

function addDays(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.getUTCDay() };
}

function isoAt(y: number, m: number, d: number, h: number, min: number) {
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00${TZ_OFFSET}`;
}

function buildBusinessDays(): { y: number; m: number; d: number; weekday: number }[] {
  const today = nowInSaoPaulo();
  const days: { y: number; m: number; d: number; weekday: number }[] = [];
  let offset = 1; // sempre a partir de amanhã
  while (days.length < BUSINESS_DAYS_AHEAD) {
    const day = addDays(today.y, today.m, today.d, offset);
    if (day.weekday !== 0 && day.weekday !== 6) days.push(day);
    offset++;
  }
  return days;
}

async function getOwnedCompany(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("company_user")
    .select("company_id, role, company:company(id, nome, telefone, selected_plan_slug)")
    .eq("user_id", userId)
    .eq("ativo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Sem empresa.");
  return { companyId: data.company_id as string, company: data.company as any };
}

export const listAvailableSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin: sa } = await import("@/integrations/supabase/client.server");
    const admin: any = sa;
    const { data: cfg } = await admin.from("app_config").select("google_conectado").eq("id", true).maybeSingle();
    if (!cfg?.google_conectado) return { connected: false as const, days: [] as Day[], existingBooking: null as { scheduled_start: string; scheduled_end: string } | null };

    const { companyId } = await getOwnedCompany(context.supabase, context.userId);

    const { data: existing } = await admin
      .from("specialist_booking")
      .select("scheduled_start, scheduled_end, status")
      .eq("company_id", companyId)
      .eq("status", "agendado")
      .order("scheduled_start", { ascending: true })
      .limit(1)
      .maybeSingle();

    const businessDays = buildBusinessDays();
    const rangeStart = isoAt(businessDays[0].y, businessDays[0].m, businessDays[0].d, 0, 0);
    const last = businessDays[businessDays.length - 1];
    const rangeEnd = isoAt(last.y, last.m, last.d, 23, 59);

    const { data: taken } = await admin
      .from("specialist_booking")
      .select("scheduled_start")
      .eq("status", "agendado")
      .gte("scheduled_start", rangeStart)
      .lte("scheduled_start", rangeEnd);
    const takenSet = new Set((taken ?? []).map((r: any) => r.scheduled_start));

    const days: Day[] = businessDays.map((day) => {
      const slots: Slot[] = [];
      for (let h = START_HOUR; h < END_HOUR; h++) {
        for (let min = 0; min < 60; min += SLOT_MINUTES) {
          const start = isoAt(day.y, day.m, day.d, h, min);
          const endMin = min + SLOT_MINUTES;
          const endH = endMin >= 60 ? h + 1 : h;
          const end = isoAt(day.y, day.m, day.d, endH, endMin % 60);
          if (takenSet.has(start)) continue;
          slots.push({ start, end, label: `${pad(h)}:${pad(min)}` });
        }
      }
      return {
        date: `${day.y}-${pad(day.m)}-${pad(day.d)}`,
        label: new Date(Date.UTC(day.y, day.m - 1, day.d)).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }),
        slots,
      };
    });

    return { connected: true as const, days, existingBooking: existing ?? null };
  });

export const createSpecialistBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { start: string; contatoNome?: string | null; contatoTelefone?: string | null }) => d)
  .handler(async ({ context, data }) => {
    const { supabaseAdmin: sa } = await import("@/integrations/supabase/client.server");
    const admin: any = sa;
    const { companyId, company } = await getOwnedCompany(context.supabase, context.userId);

    const start = new Date(data.start);
    if (Number.isNaN(start.getTime())) throw new Error("Horário inválido.");
    const end = new Date(start.getTime() + SLOT_MINUTES * 60000);

    const { data: alreadyTaken } = await admin
      .from("specialist_booking")
      .select("id")
      .eq("scheduled_start", start.toISOString())
      .eq("status", "agendado")
      .maybeSingle();
    if (alreadyTaken) throw new Error("Esse horário acabou de ser reservado por outra pessoa. Escolha outro.");

    const buyerEmail = ((context as any).claims?.email as string | undefined) || "";
    const empresaNome = company?.nome || "Empresa";
    const contatoNome = data.contatoNome?.trim() || null;

    const { createMasterCalendarEvent, appendToMasterSpreadsheet } = await import("@/lib/google.server");

    let googleEventId: string | null = null;
    try {
      const ev = await createMasterCalendarEvent(admin, {
        titulo: `Onboarding — ${empresaNome}`,
        inicio: start.toISOString(),
        fim: end.toISOString(),
        descricao: `Contato: ${contatoNome || "—"}\nE-mail: ${buyerEmail}\nTelefone: ${data.contatoTelefone || company?.telefone || "—"}\nPlano: ${company?.selected_plan_slug || "—"}`,
      });
      googleEventId = ev.eventId;
    } catch (e: any) {
      if (e?.message === "SLOT_OCUPADO") throw new Error("Esse horário já está ocupado na agenda. Escolha outro.");
      console.error("[specialist-booking] falha ao criar evento na agenda:", e?.message || e);
    }

    const { error: insertErr } = await admin.from("specialist_booking").insert({
      company_id: companyId,
      buyer_name: contatoNome,
      buyer_email: buyerEmail,
      buyer_phone: data.contatoTelefone || company?.telefone || null,
      plano_slug: company?.selected_plan_slug || null,
      scheduled_start: start.toISOString(),
      scheduled_end: end.toISOString(),
      google_event_id: googleEventId,
      status: "agendado",
    });
    if (insertErr) throw new Error(insertErr.message.includes("duplicate") ? "Esse horário acabou de ser reservado por outra pessoa. Escolha outro." : insertErr.message);

    const dataHoraBR = start.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
    try {
      await appendToMasterSpreadsheet(admin, [dataHoraBR, empresaNome, contatoNome || "—", buyerEmail, data.contatoTelefone || company?.telefone || "—", company?.selected_plan_slug || "—"]);
    } catch (e: any) {
      console.error("[specialist-booking] falha ao gravar na planilha:", e?.message || e);
    }

    try {
      const { data: cfg } = await admin.from("app_config").select("super_admin_emails").eq("id", true).maybeSingle();
      const { renderInternalAlertEmail } = await import("@/lib/email/templates");
      const { sendEmail } = await import("@/lib/email/send");
      const { subject, html } = renderInternalAlertEmail({
        tipo: "agendamento",
        empresa: empresaNome,
        contatoNome,
        contatoEmail: buyerEmail,
        detalhe: `Onboarding marcado para ${dataHoraBR}.`,
      });
      for (const to of (cfg?.super_admin_emails ?? []) as string[]) {
        await sendEmail(to, subject, html).catch(() => {});
      }
    } catch (e: any) {
      console.error("[specialist-booking] falha ao mandar alerta interno:", e?.message || e);
    }

    return { ok: true, scheduledStart: start.toISOString() };
  });
