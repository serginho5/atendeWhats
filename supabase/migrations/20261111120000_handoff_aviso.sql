-- Handoff com aviso: a IA marca [HANDOFF: motivo], o contato é pausado e o responsável
-- (telefone_transferencia) recebe o resumo da conversa no WhatsApp. Desligado por padrão.
alter table public.agent_config add column if not exists handoff_aviso boolean not null default false;
alter table public.agent_config add column if not exists handoff_quando text not null default '';
