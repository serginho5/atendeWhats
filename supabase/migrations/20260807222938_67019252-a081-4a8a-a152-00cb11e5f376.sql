CREATE OR REPLACE FUNCTION public.bootstrap_current_user()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  _email text;
  _exists boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  SELECT email INTO _email FROM auth.users WHERE id = auth.uid();
  IF _email IS NULL THEN RETURN; END IF;

  INSERT INTO public.profiles (user_id, email)
  VALUES (auth.uid(), _email)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE role = 'super_admin'::public.app_role
  ) INTO _exists;

  IF _exists THEN RETURN; END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (auth.uid(), 'super_admin'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.app_config (id, super_admin_emails)
  VALUES (true, ARRAY[_email])
  ON CONFLICT (id) DO UPDATE
    SET super_admin_emails = (
      SELECT ARRAY(SELECT DISTINCT unnest(public.app_config.super_admin_emails || ARRAY[_email]))
    ),
    updated_at = now();
END $$;

REVOKE ALL ON FUNCTION public.bootstrap_current_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_current_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_current_user() TO service_role;

INSERT INTO public.plan (slug, nome, descricao, preco_cents, moeda, intervalo, trial_days, limite_mensagens, limite_instancias, limite_usuarios, limite_contatos, features, destaque, ativo, ordem, creditos_mensais, creditos_trial)
VALUES
  ('trial', 'Trial', 'Teste gratuito por 7 dias', 0, 'BRL', 'month', 7, 500, 1, 2, 500, '["agente_ia","crm","conversas"]'::jsonb, false, true, 0, 500, 500),
  ('starter', 'Starter', 'Para quem esta comecando', 9700, 'BRL', 'month', 7, 3000, 1, 3, 3000, '["agente_ia","crm","conversas","contatos"]'::jsonb, false, true, 1, 3000, 500),
  ('pro', 'Pro', 'Para times em crescimento', 19700, 'BRL', 'month', 7, 10000, 2, 8, 15000, '["agente_ia","crm","conversas","contatos","campanhas","relatorios","google_agenda"]'::jsonb, true, true, 2, 10000, 500),
  ('business', 'Business', 'Alto volume e multiplos numeros', 49700, 'BRL', 'month', 7, 50000, 5, 25, 100000, '["agente_ia","crm","conversas","contatos","campanhas","relatorios","google_agenda","financeiro","api","webhooks"]'::jsonb, false, true, 3, 50000, 500)
ON CONFLICT (slug) DO NOTHING;