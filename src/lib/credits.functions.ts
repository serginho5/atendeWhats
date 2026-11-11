import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Saldo + últimos 20 lançamentos para a empresa atual
export const getMyCredits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { resolveMembership } = await import("./company-context.server");
    const m = await resolveMembership(context.supabase, context.userId);
    const cu = m ? { company_id: m.companyId } : null;
    if (!cu) return { saldo: 0, origem: "trial", resetam_em: null, ledger: [] as any[] };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [comp, led] = await Promise.all([
      supabaseAdmin.from("company").select("creditos_saldo, creditos_origem, creditos_resetam_em").eq("id", cu.company_id).maybeSingle(),
      supabaseAdmin.from("credit_ledger").select("delta, saldo_apos, motivo, ref, created_at").eq("company_id", cu.company_id).order("created_at", { ascending: false }).limit(20),
    ]);
    return {
      saldo: comp.data?.creditos_saldo ?? 0,
      origem: comp.data?.creditos_origem ?? "trial",
      resetam_em: comp.data?.creditos_resetam_em ?? null,
      ledger: led.data ?? [],
    };
  });

// Admin: adiciona/remove créditos numa empresa
export const adminGrantCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { companyId: string; qtd: number; motivo?: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: novo, error } = await context.supabase.rpc("grant_credits", {
      _company_id: data.companyId,
      _qtd: data.qtd,
      _motivo: data.motivo || "bonus_admin",
    });
    if (error) throw new Error(error.message);
    return { saldo: novo as number };
  });
