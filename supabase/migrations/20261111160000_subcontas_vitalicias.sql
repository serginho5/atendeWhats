-- Subcontas vitalícias: empresas internas ligadas a uma conta-mãe (ex.: os chips de prospecção da AW3S).
-- status_cobranca = 'vitalicio' → sem teste de 7 dias, sem paywall, IA não consome créditos,
-- limites do plano mais alto. Só o super admin cria ou altera (pelo /master).
alter table public.company add column if not exists conta_mae_id uuid references public.company(id) on delete set null;
create index if not exists company_conta_mae_idx on public.company(conta_mae_id);
