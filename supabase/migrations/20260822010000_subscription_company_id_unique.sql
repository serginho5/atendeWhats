-- O webhook de cobrança (src/routes/api/public/billing/webhook.ts) faz
-- upsert(..., { onConflict: "company_id" }) na tabela subscription, assumindo
-- 1 assinatura por empresa. Sem essa constraint o upsert falha silenciosamente
-- (o cliente do supabase-js não propaga o erro do Postgres) e o registro de
-- assinatura nunca é atualizado, mesmo com company.status_cobranca correto.
alter table public.subscription
  add constraint subscription_company_id_key unique (company_id);
