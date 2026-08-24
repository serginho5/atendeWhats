-- Conexão Google do dono da plataforma (singleton, mesma tabela do
-- super_admin_emails) e tabela de agendamentos de onboarding com o
-- especialista. Ver memória "payment_first_signup_flow" / plano de
-- agendamento pós-compra.

alter table public.app_config
  add column google_email text,
  add column google_access_token text,
  add column google_refresh_token text,
  add column google_expiry timestamptz,
  add column google_calendar_id text default 'primary',
  add column google_spreadsheet_id text,
  add column google_conectado boolean not null default false;

create table public.specialist_booking (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  buyer_name text,
  buyer_email text not null,
  buyer_phone text,
  plano_slug text,
  scheduled_start timestamptz not null unique,
  scheduled_end timestamptz not null,
  google_event_id text,
  status text not null default 'agendado',
  created_at timestamptz not null default now()
);

-- RLS habilitada e sem nenhuma policy pra authenticated: é uma agenda
-- compartilhada entre TODAS as empresas (um único especialista), então não dá
-- pra abrir por company_id como as outras tabelas — um cliente não pode ver
-- nome/e-mail de outro. Disponibilidade e criação passam só por server
-- functions com supabaseAdmin (service role), nunca client-side direto.
alter table public.specialist_booking enable row level security;
