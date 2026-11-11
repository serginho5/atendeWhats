import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveCompanyId(supabase: any, userId: string): Promise<string> {
  // Respeita o "Entrar como" do /master (ver src/lib/company-context.server.ts)
  const { resolveMembership } = await import("./company-context.server");
  const m = await resolveMembership(supabase, userId);
  if (!m) throw new Error("Sem empresa.");
  return m.companyId;
}

// ---------- Webhooks ----------
export const listWebhooks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("webhook_endpoint").select("*").eq("company_id", cid).order("created_at", { ascending: false });
    return data ?? [];
  });

export const saveWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; nome: string; url: string; eventos: string[]; ativo: boolean }) => d)
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    if (!/^https?:\/\//.test(data.url)) throw new Error("URL deve começar com http(s)://");
    const payload = { company_id: cid, nome: data.nome, url: data.url, eventos: data.eventos, ativo: data.ativo };
    if (data.id) {
      const { error } = await context.supabase.from("webhook_endpoint").update(payload).eq("id", data.id).eq("company_id", cid);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase.from("webhook_endpoint").insert(payload);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const deleteWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { error } = await context.supabase.from("webhook_endpoint").delete().eq("id", data.id).eq("company_id", cid);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listWebhookLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("webhook_delivery_log").select("*").eq("company_id", cid).order("created_at", { ascending: false }).limit(50);
    return data ?? [];
  });

// ---------- API tokens ----------
export const listApiTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("api_token").select("*").eq("company_id", cid).order("created_at", { ascending: false });
    return data ?? [];
  });

export const createApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { label: string }) => d)
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    // Gating: recurso "apiWebhooks" do plano (Business, ou subconta vitalícia)
    const { getCompanyPlan } = await import("./plan-limits.server");
    const { featuresFor } = await import("./plan-features");
    const plan = await getCompanyPlan(cid);
    if (!featuresFor(plan.rawSlug || plan.slug).apiWebhooks) throw new Error("API pública disponível apenas no plano Business.");
    const { data: row, error } = await context.supabase
      .from("api_token").insert({ company_id: cid, label: data.label, criado_por: context.userId })
      .select("*").maybeSingle();
    if (error || !row) throw new Error(error?.message ?? "Falha.");
    return row;
  });

export const revokeApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { error } = await context.supabase.from("api_token").update({ revogado: true }).eq("id", data.id).eq("company_id", cid);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
