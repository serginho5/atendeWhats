-- ============================================================================
-- RECONSTRUÇÃO DO SCHEMA BASE — Atende+Empresas
-- Gerado a partir de src/integrations/supabase/types.ts + análise do código,
-- pois o projeto original (Lovable Cloud) nunca versionou o schema base em
-- supabase/migrations — só existiam 4 migrations incrementais.
-- Rode este arquivo ANTES das 4 migrations já existentes em supabase/migrations.
-- ============================================================================

-- ---------- ENUMS ----------
create type public.app_role as enum ('super_admin');
create type public.tenant_role as enum ('owner','admin','atendente');
create type public.stage_tipo as enum ('normal','ganho','perda');
create type public.campaign_status as enum ('rascunho','agendada','enviando','pausada','concluida','cancelada');
create type public.campaign_target_status as enum ('pendente','enviado','falhou','pulado');
create type public.fin_tipo as enum ('receita','despesa');
create type public.fin_status as enum ('pendente','pago','atrasado','cancelado');
create type public.fin_forma as enum ('pix','boleto','cartao','dinheiro','transferencia','outro');

-- ---------- TABELAS ----------

create table public.company (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  slug text not null unique,
  primary_color text not null default '#16A34A',
  logo_url text,
  telefone text,
  status_cobranca text not null default 'trial',
  trial_ate timestamptz not null default (now() + interval '7 days'),
  onboarding_completed boolean not null default false,
  onboarding_step integer not null default 0,
  tipo_pessoa text not null default 'pj',
  cnpj_cpf text,
  razao_social text,
  nome_fantasia text,
  segmento text,
  porte text,
  site text,
  email_corporativo text,
  cep text,
  rua text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  estado text,
  pais text,
  inscricao_estadual text,
  financeiro_ativo boolean not null default false,
  financeiro_dias_vencimento_padrao integer not null default 7,
  selected_plan_slug text,
  creditos_saldo integer not null default 0,
  creditos_origem text not null default 'trial',
  creditos_resetam_em timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nome text,
  nome_completo text,
  cargo text,
  cpf text,
  telefone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create table public.app_config (
  id boolean primary key default true,
  super_admin_emails text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id)
);

create table public.company_user (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.tenant_role not null default 'atendente',
  ativo boolean not null default true,
  forcar_troca_senha boolean not null default false,
  convite_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_billing (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references public.company(id) on delete cascade,
  tipo_pessoa text not null default 'pj',
  cnpj_cpf text,
  razao_social text,
  inscricao_estadual text,
  nome_responsavel text,
  email_cobranca text,
  telefone text,
  cep text,
  rua text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  estado text,
  pais text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plan (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  nome text not null,
  descricao text,
  preco_cents integer not null default 0,
  moeda text not null default 'BRL',
  intervalo text not null default 'month',
  trial_days integer not null default 7,
  limite_mensagens integer not null default 0,
  limite_instancias integer not null default 1,
  limite_usuarios integer not null default 1,
  limite_contatos integer not null default 0,
  features jsonb not null default '[]'::jsonb,
  destaque boolean not null default false,
  ativo boolean not null default true,
  ordem integer not null default 0,
  creditos_mensais integer not null default 0,
  creditos_trial integer not null default 0,
  checkout_url text,
  paddle_price_id text,
  paddle_product_id text,
  stripe_price_id text,
  stripe_product_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscription (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  plan_id uuid references public.plan(id),
  status text not null default 'trialing',
  provider text not null default 'manual',
  buyer_email text,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  external_customer_id text,
  external_subscription_id text,
  paddle_customer_id text,
  paddle_subscription_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  payment_method_brand text,
  payment_method_last4 text,
  payment_method_exp text,
  next_billing_amount_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_config (
  company_id uuid primary key references public.company(id) on delete cascade,
  user_id uuid not null,
  nome_agente text not null default 'Assistente',
  nome_empresa text not null default '',
  sobre_empresa text not null default '',
  segmento text not null default '',
  descricao_negocio text not null default '',
  publico_alvo text not null default '',
  produtos_servicos text not null default '',
  ofertas text not null default '',
  diferenciais text not null default '',
  ticket_medio text not null default '',
  formas_pagamento text not null default '',
  papel_objetivo text not null default '',
  apresentacao text not null default '',
  como_vender text not null default '',
  objecoes text not null default '',
  faq text not null default '',
  politicas text not null default '',
  pode_fazer text not null default '',
  nao_pode_fazer text not null default '',
  telefone_transferencia text not null default '',
  estilo_comunicacao text not null default 'consultivo',
  formalidade integer not null default 5,
  tom integer not null default 5,
  tamanho_resposta text not null default 'medio',
  emoji_intensidade text,
  evitar_palavras text,
  personalidade text,
  foco_atendimento text,
  idioma text default 'pt-BR',
  velocidade_resposta text,
  usar_emojis boolean not null default true,
  usar_girias boolean,
  pode_brincar boolean,
  chamar_por_nome boolean,
  assinar_mensagens boolean,
  perguntar_uma_por_vez boolean,
  responder_em_partes boolean not null default false,
  pedir_avaliacao boolean not null default false,
  reativar_cliente boolean not null default false,
  proatividade integer,
  segundos_buffer integer not null default 8,
  horarios_atendimento jsonb not null default '{}'::jsonb,
  horarios_disponiveis text not null default '',
  mensagem_fora_horario text not null default '',
  regiao_horario text not null default 'America/Sao_Paulo',
  agendamento_ativo boolean not null default false,
  duracao_padrao text not null default '30',
  antecedencia_min text not null default '60',
  servicos_agendaveis text not null default '',
  palavra_pausar text not null default '',
  palavra_despausar text not null default '',
  cupom text not null default '',
  posvenda_msg text not null default '',
  ai_provider text not null default 'openai',
  ai_model text not null default 'gpt-4o-mini',
  openai_api_key text not null default '',
  anthropic_api_key text not null default '',
  updated_at timestamptz not null default now()
);

create table public.crm_stage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  cor text not null default '#8AA89A',
  ordem integer not null default 0,
  tipo public.stage_tipo not null default 'normal',
  created_at timestamptz not null default now()
);

create table public.crm_cards (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid not null,
  owner_id uuid,
  stage_id uuid references public.crm_stage(id) on delete set null,
  nome text,
  numero text not null,
  status text not null default 'aberto',
  observacao text,
  origem text,
  tags text[] not null default '{}',
  valor numeric(12,2) not null default 0,
  proxima_acao text,
  follow_up timestamptz,
  ultima_mensagem text,
  ultima_em timestamptz not null default now(),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  updated_at timestamptz not null default now()
);

create table public.agendamento (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  card_id uuid references public.crm_cards(id) on delete set null,
  titulo text not null,
  inicio timestamptz not null,
  fim timestamptz not null,
  status text not null default 'agendado',
  google_event_id text,
  created_at timestamptz not null default now()
);

create table public.api_token (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  label text not null,
  token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  revogado boolean not null default false,
  criado_por uuid,
  ultimo_uso_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid,
  actor_email text,
  acao text not null,
  recurso text,
  detalhes jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table public.billing_event_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text,
  external_id text,
  buyer_email text,
  matched_company_id uuid references public.company(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create table public.campaign (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  mensagem text not null,
  media_url text,
  status public.campaign_status not null default 'rascunho',
  filtro_tags text[],
  agendado_para timestamptz,
  iniciado_em timestamptz,
  concluido_em timestamptz,
  proximo_envio_em timestamptz,
  intervalo_min_seg integer not null default 5,
  intervalo_max_seg integer not null default 15,
  pausa_apos_envios integer not null default 20,
  pausa_duracao_min integer not null default 5,
  total_destinatarios integer not null default 0,
  total_enviados integer not null default 0,
  total_falhas integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_target (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign(id) on delete cascade,
  company_id uuid not null references public.company(id) on delete cascade,
  contato_numero text not null,
  contato_nome text,
  status public.campaign_target_status not null default 'pendente',
  enviado_em timestamptz,
  erro text,
  created_at timestamptz not null default now()
);

create table public.contact_pause (
  company_id uuid not null references public.company(id) on delete cascade,
  numero text not null,
  user_id uuid not null,
  pausado boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company_id, numero)
);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  delta integer not null,
  saldo_apos integer not null,
  motivo text not null,
  ref text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.csat_response (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  numero text not null,
  contato_nome text,
  token text not null default replace(gen_random_uuid()::text, '-', ''),
  score integer,
  comentario text,
  enviado_em timestamptz not null default now(),
  enviado_por uuid,
  respondido_em timestamptz,
  updated_at timestamptz not null default now()
);

create table public.fin_categoria (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  tipo public.fin_tipo not null,
  cor text not null default '#8AA89A',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.fin_lancamento (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  tipo public.fin_tipo not null,
  descricao text not null,
  valor_cents bigint not null,
  categoria_id uuid references public.fin_categoria(id) on delete set null,
  forma_pagamento public.fin_forma,
  status public.fin_status not null default 'pendente',
  vencimento date not null,
  pago_em date,
  competencia date not null default current_date,
  crm_card_id uuid references public.crm_cards(id) on delete set null,
  contato_numero text,
  observacao text,
  anexo_url text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fin_lancamento_crm_card_unique unique (company_id, crm_card_id)
);

create table public.google_integration (
  company_id uuid primary key references public.company(id) on delete cascade,
  conectado boolean not null default false,
  email text,
  access_token text,
  refresh_token text,
  expiry timestamptz,
  calendar_id text,
  updated_at timestamptz not null default now()
);

create table public.lead_evento (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  card_id uuid not null references public.crm_cards(id) on delete cascade,
  tipo text not null,
  descricao text,
  created_at timestamptz not null default now()
);

create table public.lead_nota (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  card_id uuid not null references public.crm_cards(id) on delete cascade,
  autor_id uuid,
  texto text not null,
  created_at timestamptz not null default now()
);

create table public.mensagens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid not null,
  numero text not null,
  contato_nome text,
  direcao text not null,
  autor text not null,
  texto text not null,
  whatsapp_message_id text,
  created_at timestamptz not null default now()
);

create table public.message_template (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid,
  atalho text not null,
  texto text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.produto (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  descricao text,
  preco numeric(12,2) not null default 0,
  ativo boolean not null default true,
  ordem integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.webhook_endpoint (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  nome text not null,
  url text not null,
  secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  eventos text[] not null default '{}',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhook_delivery_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  endpoint_id uuid references public.webhook_endpoint(id) on delete cascade,
  evento text not null,
  status_code integer,
  erro text,
  created_at timestamptz not null default now()
);

create table public.whatsapp_instances (
  instance_name text primary key,
  company_id uuid not null references public.company(id) on delete cascade,
  user_id uuid not null,
  numero text,
  status text not null default 'desconectado',
  webhook_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  webhook_configured_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Índices úteis (conforme .lovable/plan.md)
create index idx_fin_lancamento_status on public.fin_lancamento (company_id, status, vencimento);
create index idx_fin_lancamento_tipo on public.fin_lancamento (company_id, tipo, competencia);
create index idx_crm_cards_company on public.crm_cards (company_id, stage_id);
create index idx_mensagens_company_numero on public.mensagens (company_id, numero, created_at);
create index idx_company_user_user on public.company_user (user_id, ativo);

-- ---------- FUNÇÕES ----------

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'super_admin'::public.app_role);
$$;

create or replace function public.has_company_role(_company_id uuid, _roles text[])
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (
    select 1 from public.company_user
    where user_id = auth.uid() and company_id = _company_id and ativo = true
      and role::text = any(_roles)
  );
$$;

create or replace function public.has_company_access(_company_id uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (
    select 1 from public.company_user
    where user_id = auth.uid() and company_id = _company_id and ativo = true
  ) or public.is_super_admin();
$$;

create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path to '' as $$
  select company_id from public.company_user
  where user_id = auth.uid() and ativo = true
  order by created_at asc limit 1;
$$;

create or replace function public.claim_super_admin_if_empty()
returns void language plpgsql security definer set search_path to '' as $$
declare _exists boolean;
begin
  if auth.uid() is null then return; end if;
  select exists (select 1 from public.user_roles where role = 'super_admin'::public.app_role) into _exists;
  if _exists then return; end if;
  insert into public.user_roles (user_id, role) values (auth.uid(), 'super_admin'::public.app_role)
  on conflict (user_id, role) do nothing;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.tg_company_trial_credits()
returns trigger language plpgsql security definer set search_path to '' as $$
declare _creditos integer;
begin
  select creditos_trial into _creditos from public.plan
  where slug = coalesce(new.selected_plan_slug, 'trial') limit 1;
  if _creditos is null then _creditos := 500; end if;

  update public.company
  set creditos_saldo = _creditos, creditos_origem = 'trial', creditos_resetam_em = new.trial_ate
  where id = new.id;

  insert into public.credit_ledger (company_id, delta, motivo, saldo_apos)
  values (new.id, _creditos, 'trial_inicial', _creditos);

  return new;
end $$;

create trigger trg_company_trial_credits
  after insert on public.company
  for each row execute function public.tg_company_trial_credits();

create or replace function public.seed_default_stages()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  insert into public.crm_stage (company_id, nome, cor, ordem, tipo) values
    (new.id, 'Novo Lead', '#3B82F6', 0, 'normal'),
    (new.id, 'Em Contato', '#F59E0B', 1, 'normal'),
    (new.id, 'Proposta', '#8B5CF6', 2, 'normal'),
    (new.id, 'Ganho', '#22C55E', 3, 'ganho'),
    (new.id, 'Perdido', '#EF4444', 4, 'perda');
  return new;
end $$;

create trigger trg_seed_default_stages
  after insert on public.company
  for each row execute function public.seed_default_stages();

create or replace function public.consume_ai_credit(_company_id uuid, _ref text default null)
returns boolean language plpgsql security definer set search_path to '' as $$
declare _saldo integer;
begin
  select creditos_saldo into _saldo from public.company where id = _company_id for update;
  if _saldo is null or _saldo <= 0 then return false; end if;
  update public.company set creditos_saldo = creditos_saldo - 1 where id = _company_id;
  insert into public.credit_ledger (company_id, delta, motivo, ref, saldo_apos)
  values (_company_id, -1, 'consumo_mensagem', _ref, _saldo - 1);
  return true;
end $$;

create or replace function public.grant_credits(_company_id uuid, _qtd integer, _motivo text default 'bonus_admin')
returns integer language plpgsql security definer set search_path to '' as $$
declare _novo integer;
begin
  if not public.is_super_admin() then
    raise exception 'Acesso negado';
  end if;
  update public.company set creditos_saldo = creditos_saldo + _qtd where id = _company_id
  returning creditos_saldo into _novo;
  if _novo is null then raise exception 'Empresa não encontrada'; end if;
  insert into public.credit_ledger (company_id, delta, motivo, saldo_apos, created_by)
  values (_company_id, _qtd, _motivo, _novo, auth.uid());
  return _novo;
end $$;

create or replace function public.topup_plan_credits(_company_id uuid, _plan_slug text)
returns integer language plpgsql security definer set search_path to '' as $$
declare _qtd integer; _novo integer;
begin
  select creditos_mensais into _qtd from public.plan where slug = _plan_slug limit 1;
  if _qtd is null then _qtd := 0; end if;
  update public.company
  set creditos_saldo = _qtd, creditos_origem = 'plano', creditos_resetam_em = now() + interval '30 days'
  where id = _company_id
  returning creditos_saldo into _novo;
  if _novo is null then raise exception 'Empresa não encontrada'; end if;
  insert into public.credit_ledger (company_id, delta, motivo, saldo_apos)
  values (_company_id, _qtd, 'renovacao_plano', _novo);
  return _novo;
end $$;

create or replace function public.seed_fin_categorias(_company_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  insert into public.fin_categoria (company_id, nome, tipo, cor)
  select _company_id, v.nome, v.tipo::public.fin_tipo, v.cor
  from (values
    ('Vendas', 'receita', '#22C55E'),
    ('Marketing', 'despesa', '#8B5CF6'),
    ('Folha', 'despesa', '#F59E0B'),
    ('Operacional', 'despesa', '#3B82F6')
  ) as v(nome, tipo, cor)
  where not exists (
    select 1 from public.fin_categoria fc where fc.company_id = _company_id and fc.nome = v.nome
  );
end $$;

create or replace function public.fin_enable_for_company(_company_id uuid, _enable boolean)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not (public.is_super_admin() or public.has_company_role(_company_id, array['owner','admin'])) then
    raise exception 'Acesso negado';
  end if;
  update public.company set financeiro_ativo = _enable where id = _company_id;
  if _enable then
    perform public.seed_fin_categorias(_company_id);
  end if;
end $$;

create or replace function public.tg_fin_auto_receita_on_ganho()
returns trigger language plpgsql security definer set search_path to '' as $$
declare _stage_tipo public.stage_tipo; _fin_ativo boolean; _dias integer; _plan_slug text;
begin
  if new.stage_id is null or new.stage_id is not distinct from old.stage_id then return new; end if;
  select tipo into _stage_tipo from public.crm_stage where id = new.stage_id;
  if _stage_tipo is distinct from 'ganho'::public.stage_tipo then return new; end if;

  select financeiro_ativo, financeiro_dias_vencimento_padrao into _fin_ativo, _dias
  from public.company where id = new.company_id;
  if not coalesce(_fin_ativo, false) then return new; end if;

  select p.slug into _plan_slug
  from public.subscription s join public.plan p on p.id = s.plan_id
  where s.company_id = new.company_id order by s.created_at desc limit 1;
  if _plan_slug is null or _plan_slug not in ('pro','business') then return new; end if;

  insert into public.fin_lancamento
    (company_id, tipo, descricao, valor_cents, status, vencimento, competencia, crm_card_id, contato_numero)
  values
    (new.company_id, 'receita', coalesce('Venda — ' || new.nome, 'Venda CRM'),
     round(coalesce(new.valor, 0) * 100), 'pendente',
     (current_date + coalesce(_dias, 7)), current_date, new.id, new.numero)
  on conflict (company_id, crm_card_id) do nothing;

  return new;
end $$;

create trigger trg_fin_auto_receita_on_ganho
  after update on public.crm_cards
  for each row execute function public.tg_fin_auto_receita_on_ganho();

-- ---------- RLS ----------

alter table public.company enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.app_config enable row level security;
alter table public.company_user enable row level security;
alter table public.company_billing enable row level security;
alter table public.plan enable row level security;
alter table public.subscription enable row level security;
alter table public.agent_config enable row level security;
alter table public.crm_stage enable row level security;
alter table public.crm_cards enable row level security;
alter table public.agendamento enable row level security;
alter table public.api_token enable row level security;
alter table public.audit_log enable row level security;
alter table public.billing_event_log enable row level security;
alter table public.campaign enable row level security;
alter table public.campaign_target enable row level security;
alter table public.contact_pause enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.csat_response enable row level security;
alter table public.fin_categoria enable row level security;
alter table public.fin_lancamento enable row level security;
alter table public.google_integration enable row level security;
alter table public.lead_evento enable row level security;
alter table public.lead_nota enable row level security;
alter table public.mensagens enable row level security;
alter table public.message_template enable row level security;
alter table public.produto enable row level security;
alter table public.webhook_endpoint enable row level security;
alter table public.webhook_delivery_log enable row level security;
alter table public.whatsapp_instances enable row level security;

-- company: membros veem a própria empresa; owner/admin atualiza
create policy company_member_select on public.company as permissive for select to authenticated
  using (public.has_company_access(id));
create policy company_admin_update on public.company as permissive for update to authenticated
  using (public.is_super_admin() or public.has_company_role(id, array['owner','admin']))
  with check (public.is_super_admin() or public.has_company_role(id, array['owner','admin']));

-- profiles: cada um vê/edita o próprio; admins veem time (policy completa entra na migration seguinte)
create policy profiles_self_select on public.profiles as permissive for select to authenticated
  using (auth.uid() = user_id or public.is_super_admin());
create policy profiles_self_upsert on public.profiles as permissive for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- user_roles: cada um vê o próprio papel; só super_admin gerencia
create policy user_roles_self_select on public.user_roles as permissive for select to authenticated
  using (auth.uid() = user_id or public.is_super_admin());
create policy user_roles_super_admin_all on public.user_roles as permissive for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- app_config: só super_admin
create policy app_config_super_admin on public.app_config as permissive for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- company_user: membros veem colegas da empresa; owner/admin gerencia
create policy company_user_member_select on public.company_user as permissive for select to authenticated
  using (public.has_company_access(company_id));
create policy company_user_admin_write on public.company_user as permissive for all to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']))
  with check (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));

-- plan: leitura pública dos planos ativos; gestão só super_admin
-- (separado por role: anon não deve invocar is_super_admin(), pois a migration
-- seguinte revoga EXECUTE dessa função para anon)
create policy plan_anon_select on public.plan as permissive for select to anon
  using (ativo = true);
create policy plan_authenticated_select on public.plan as permissive for select to authenticated
  using (ativo = true or public.is_super_admin());
create policy plan_super_admin_write on public.plan as permissive for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- subscription: leitura owner/admin (write via service role nos webhooks)
create policy subscription_owner_admin_read_base on public.subscription as permissive for select to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));

-- tabelas operacionais: qualquer membro ativo da empresa acessa
create policy crm_stage_access on public.crm_stage as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy crm_cards_access on public.crm_cards as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy agendamento_access on public.agendamento as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy mensagens_access on public.mensagens as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy message_template_access on public.message_template as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy produto_access on public.produto as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy contact_pause_access on public.contact_pause as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy campaign_access on public.campaign as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy campaign_target_access on public.campaign_target as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy csat_response_access on public.csat_response as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy lead_evento_access on public.lead_evento as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy lead_nota_access on public.lead_nota as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy fin_categoria_access on public.fin_categoria as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy fin_lancamento_access on public.fin_lancamento as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
create policy whatsapp_instances_access on public.whatsapp_instances as permissive for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

-- tabelas sensíveis: só owner/admin (ou super_admin)
create policy api_token_owner_admin on public.api_token as permissive for all to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']))
  with check (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));
create policy audit_log_owner_admin on public.audit_log as permissive for select to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));
create policy credit_ledger_owner_admin on public.credit_ledger as permissive for select to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));
create policy webhook_endpoint_owner_admin on public.webhook_endpoint as permissive for all to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']))
  with check (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));
create policy webhook_delivery_log_owner_admin on public.webhook_delivery_log as permissive for select to authenticated
  using (public.is_super_admin() or public.has_company_role(company_id, array['owner','admin']));

-- agent_config, company_billing, google_integration, subscription (write):
-- políticas definitivas já vêm na migration 20260812174653 (mantidas como estão).
-- billing_event_log: só service_role (nenhuma policy para authenticated/anon = acesso negado por padrão).

-- ---------- GRANTS ----------

grant usage on schema public to anon, authenticated, service_role;

grant select on public.plan to anon;

grant select, insert, update, delete on
  public.company, public.profiles, public.user_roles, public.app_config, public.company_user,
  public.company_billing, public.plan, public.subscription, public.agent_config, public.crm_stage,
  public.crm_cards, public.agendamento, public.api_token, public.audit_log, public.campaign,
  public.campaign_target, public.contact_pause, public.credit_ledger, public.csat_response,
  public.fin_categoria, public.fin_lancamento, public.google_integration, public.lead_evento,
  public.lead_nota, public.mensagens, public.message_template, public.produto,
  public.webhook_endpoint, public.webhook_delivery_log, public.whatsapp_instances
to authenticated;

grant all on all tables in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

-- EXECUTE em cada função é concedido function-a-função pelas migrations
-- 20260812174617 e 20260812174653 (já existentes em supabase/migrations),
-- que restringem consume_ai_credit/topup_plan_credits/seed_fin_categorias
-- a service_role e as demais a authenticated. Rode este arquivo e depois
-- as 4 migrations existentes, nessa ordem.
