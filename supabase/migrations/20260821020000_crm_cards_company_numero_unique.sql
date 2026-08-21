-- crm_cards não tinha UNIQUE em (company_id, numero).
-- O webhook do WhatsApp (upsertCard em whatsapp-webhook.ts) faz
-- .upsert(payload, { onConflict: "company_id,numero" }), que falhava
-- silenciosamente no Postgres (erro 42P10, nunca verificado no client),
-- fazendo o CRM Kanban nunca receber cards das conversas recebidas.
ALTER TABLE public.crm_cards
  ADD CONSTRAINT crm_cards_company_id_numero_key UNIQUE (company_id, numero);
