import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { slugify } from "@/lib/tenant";
import { updateUserPlanInMasterSheet } from "@/lib/google.server";

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

    // A empresa nasce em período de teste (7 dias, sem cartão). O acesso só
    // fica bloqueado quando o trial vence ou a assinatura fica inadimplente
    // (ver gating em src/routes/app.tsx).
    //
    // O trial libera exatamente os recursos/limites do plano que a pessoa
    // escolheu no checkout — nada de Starter "experimentar" recursos do Pro.
    // Isso evita que ela ache, ao assinar o Starter de verdade, que perdeu
    // acesso a algo que já era dela.
    let planSlug = data.plano_slug;
    let planId: string | null = null;
    let planNome: string | null = null;
    let planTrialDays = 7;
    if (planSlug) {
      const { data: plan } = await supabaseAdmin
        .from("plan")
        .select("id, slug, nome, trial_days")
        .eq("slug", planSlug)
        .maybeSingle();
      planId = plan?.id ?? null;
      planNome = plan?.nome ?? null;
      if (plan?.trial_days) planTrialDays = plan.trial_days;
    } else {
      const { data: starter } = await supabaseAdmin
        .from("plan")
        .select("id, slug, nome, trial_days")
        .eq("slug", "starter")
        .maybeSingle();
      planSlug = starter?.slug ?? null;
      planId = starter?.id ?? null;
      planNome = starter?.nome ?? null;
      if (starter?.trial_days) planTrialDays = starter.trial_days;
    }
    if (!planId) throw new Error("Plano não encontrado — avise o administrador.");

    const slug = `${slugify(data.nome)}-${Math.random().toString(36).slice(2, 6)}`;
    const trialAte = new Date(Date.now() + planTrialDays * 86400000).toISOString();

    const { data: company, error: companyErr } = await supabaseAdmin
      .from("company")
      .insert({
        nome: data.nome,
        slug,
        primary_color: "#25D366",
        created_by: context.userId,
        status_cobranca: "trial",
        onboarding_completed: false,
        onboarding_step: 0,
        trial_ate: trialAte,
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

    const { error: subErr } = await supabaseAdmin.from("subscription").insert({
      company_id: company.id,
      plan_id: planId,
      status: "trialing",
      trial_ends_at: trialAte,
    });
    if (subErr) throw subErr;

    const email = (context.claims as any)?.email as string | undefined;
    if (email && planNome) {
      try {
        await updateUserPlanInMasterSheet(supabaseAdmin, { email, planoNome: planNome });
      } catch (e: any) {
        console.error("[checkout] falha ao atualizar plano na planilha:", e?.message || e);
      }
    }

    return { companyId: company.id as string };
  });
