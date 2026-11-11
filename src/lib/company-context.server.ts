// SERVER ONLY. Empresa em que a chamada atual deve agir.
// 1) Super admin com "Entrar como" ativo nesta aba (header x-master-impersonate) → a empresa escolhida.
// 2) Senão → a empresa mais antiga do usuário (comportamento de sempre).
import { getRequest } from "@tanstack/react-start/server";
import { IMPERSONATE_HEADER } from "./impersonation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Empresa + papel do usuário nela. No "Entrar como" do super admin, o papel é "owner" (igual ao app.tsx). */
export async function resolveMembership(supabase: any, userId: string): Promise<{ companyId: string; role: string } | null> {
  let alvo: string | null = null;
  try { alvo = getRequest()?.headers?.get(IMPERSONATE_HEADER) ?? null; } catch {}

  if (alvo && UUID.test(alvo)) {
    const { data: role } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "super_admin").maybeSingle();
    if (role) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: comp } = await (supabaseAdmin as any).from("company").select("id").eq("id", alvo).maybeSingle();
      if (comp) return { companyId: comp.id as string, role: "owner" };
    }
    // Header inválido ou usuário sem permissão: ignora e segue o fluxo normal.
  }

  const { data, error } = await supabase
    .from("company_user")
    .select("company_id, role")
    .eq("user_id", userId)
    .eq("ativo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { companyId: data.company_id as string, role: data.role as string } : null;
}

export async function resolveCompanyId(supabase: any, userId: string): Promise<string> {
  const m = await resolveMembership(supabase, userId);
  if (!m) throw new Error("Você ainda não possui uma empresa. Finalize o onboarding.");
  return m.companyId;
}
