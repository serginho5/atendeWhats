-- Especialistas do agente (2026-11-24): o agente principal (ex.: Sofia) continua sendo uma só pessoa para o
-- cliente, mas a cada mensagem um roteador escolhe o especialista do assunto (vendas, financeiro, suporte,
-- projetos…) e junta as instruções e o conhecimento dele ao prompt. Sem especialistas ativos, nada muda.

create table if not exists public.agent_specialist (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  quando_usar text not null default '',
  instrucoes text not null default '',
  conhecimento text not null default '',
  passar_para_humano boolean not null default true,
  ativo boolean not null default true,
  ordem integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_specialist_company_idx on public.agent_specialist (company_id, ordem);

alter table public.agent_specialist enable row level security;
drop policy if exists agent_specialist_company on public.agent_specialist;
create policy agent_specialist_company on public.agent_specialist
  for all to authenticated
  using (public.has_company_access(company_id))
  with check (public.has_company_access(company_id));

-- Assunto atual da conversa: evita trocar de especialista a cada mensagem
alter table public.crm_cards add column if not exists especialista_atual text;

-- Registro de cada troca de especialista (para ver onde o agente precisa aprender)
create table if not exists public.specialist_route_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  numero text not null,
  de text,
  para text,
  mensagem text,
  created_at timestamptz not null default now()
);
create index if not exists specialist_route_log_company_idx on public.specialist_route_log (company_id, created_at desc);

alter table public.specialist_route_log enable row level security;
drop policy if exists specialist_route_log_company on public.specialist_route_log;
create policy specialist_route_log_company on public.specialist_route_log
  for select to authenticated
  using (public.has_company_access(company_id));
