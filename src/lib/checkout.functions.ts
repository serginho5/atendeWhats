import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { slugify } from "@/lib/tenant";

export const createCheckoutCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { nome: string; plano_slug?: string }) => {
    const nome = String(d.nome || "").trim();
    if (nome.length < 2) throw new Error("Informe o nome da sua empresa.");
    const plano_slug = d.plano_slug ? String(d.plano_slug).toLowerCase().trim() : null;
    return { nome, plano_slug };
  })
  .handler(async ({ context, data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("company_user")
      .select("company_id")
      .eq("user_id", context.userId)
      .eq("ativo", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing?.company_id) return { companyId: existing.company_id as string };

    // Sem trial: a empresa nasce "pendente" e só é liberada quando o pagamento
    // da implementação (ativação) é confirmado pelo webhook de cobrança.
    // trial_ate/creditos_resetam_em continuam existindo só como bookkeeping
    // técnico dos créditos iniciais — não representam mais um período de teste.
    let planSlug = data.plano_slug;
    let planId: string | null = null;
    if (planSlug) {
      const { data: plan } = await supabaseAdmin
        .from("plan")
        .select("id, slug")
        .eq("slug", planSlug)
        .maybeSingle();
      planId = plan?.id ?? null;
    } else {
      const { data: starter } = await supabaseAdmin
        .from("plan")
        .select("id, slug")
        .eq("slug", "starter")
        .maybeSingle();
      planSlug = starter?.slug ?? null;
      planId = starter?.id ?? null;
    }

    const slug = `${slugify(data.nome)}-${Math.random().toString(36).slice(2, 6)}`;
    const creditosResetamEm = new Date(Date.now() + 30 * 86400000).toISOString();

    const { data: company, error: companyErr } = await supabaseAdmin
      .from("company")
      .insert({
        nome: data.nome,
        slug,
        primary_color: "#25D366",
        created_by: context.userId,
        status_cobranca: "pendente",
        onboarding_completed: false,
        onboarding_step: 0,
        trial_ate: creditosResetamEm,
        selected_plan_slug: planSlug,
      } as any)
      .select("id")
      .single();
    if (companyErr || !company) throw new Error(companyErr?.message || "Falha ao criar empresa");

    const { error: memberErr } = await supabaseAdmin.from("company_user").insert({
      user_id: context.userId,
      company_id: company.id,
      role: "owner",
      ativo: true,
    });
    if (memberErr) throw memberErr;

    // Sem isso, getCompanyPlan() não encontra assinatura e as features/limites
    // do plano escolhido não valem até o pagamento confirmar (status
    // "trialing" aqui só significa "assinatura ainda não confirmada" —
    // getCompanyPlan() a reconhece como válida enquanto aguarda o webhook).
    if (planId) {
      const { error: subErr } = await supabaseAdmin.from("subscription").insert({
        company_id: company.id,
        plan_id: planId,
        status: "trialing",
      });
      if (subErr) throw subErr;
    }

    return { companyId: company.id as string };
  });
