DROP POLICY IF EXISTS agent_config_owner_admin ON public.agent_config;
CREATE POLICY agent_config_owner_admin ON public.agent_config
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS billing_owner_admin_read ON public.company_billing;
CREATE POLICY billing_owner_admin_read ON public.company_billing
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS billing_owner_admin_write ON public.company_billing;
CREATE POLICY billing_owner_admin_write ON public.company_billing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS google_integration_owner_admin ON public.google_integration;
CREATE POLICY google_integration_owner_admin ON public.google_integration
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS subscription_owner_admin_read ON public.subscription;
CREATE POLICY subscription_owner_admin_read ON public.subscription
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin() OR has_company_role(company_id, ARRAY['owner','admin']));

DROP POLICY IF EXISTS profiles_company_admin_select ON public.profiles;
CREATE POLICY profiles_company_admin_select ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM company_user me
    JOIN company_user target ON target.company_id = me.company_id
    WHERE me.user_id = auth.uid()
      AND me.ativo = true
      AND me.role = ANY (ARRAY['owner'::tenant_role, 'admin'::tenant_role])
      AND target.user_id = profiles.user_id
      AND target.ativo = true
  ));

REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_company_trial_credits() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_fin_auto_receita_on_ganho() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_default_stages() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_fin_categorias(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_ai_credit(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.topup_plan_credits(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_super_admin_if_empty() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.is_super_admin() FROM anon;
REVOKE ALL ON FUNCTION public.has_company_role(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.has_company_access(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.current_company_id() FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_current_user() FROM anon;
REVOKE ALL ON FUNCTION public.grant_credits(uuid, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.fin_enable_for_company(uuid, boolean) FROM anon;

GRANT EXECUTE ON FUNCTION public.bootstrap_current_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_enable_for_company(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_company_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated;