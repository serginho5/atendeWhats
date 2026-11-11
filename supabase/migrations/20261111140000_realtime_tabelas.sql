-- Liga o tempo real nas tabelas que a tela Conversas e o CRM escutam.
-- A publicação supabase_realtime estava vazia (perdida na reconstrução do schema):
-- a tela só atualizava ao recarregar ou ao trocar de conversa.
alter publication supabase_realtime add table public.mensagens, public.contact_pause, public.crm_cards, public.crm_stage;
