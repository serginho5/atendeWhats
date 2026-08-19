-- whatsapp_instances tinha só instance_name como PK, sem UNIQUE em company_id.
-- O código em evolution.functions.ts faz .upsert(..., { onConflict: "company_id" }),
-- que falhava silenciosamente no Postgres (erro nunca verificado no client),
-- fazendo o status da conexão nunca ser persistido no banco.
ALTER TABLE public.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_company_id_key UNIQUE (company_id);
