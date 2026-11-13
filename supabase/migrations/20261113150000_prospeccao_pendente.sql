-- Isca em duas etapas (máquina de vendas da AW3S, 2026-11-13):
-- a abertura vai sozinha (só texto); a isca (blocos de texto + prints) fica guardada aqui
-- e é entregue pelo webhook quando o contato responde pela primeira vez.
create table if not exists public.prospeccao_pendente (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  numero text not null,
  textos jsonb not null default '[]'::jsonb,   -- ["bloco 1", "bloco 2", …]
  imagens jsonb not null default '[]'::jsonb,  -- [{ base64, mimetype, nome }], enviadas depois dos textos
  ref_externa text,
  status text not null default 'pendente',     -- pendente | entregando | entregue | cancelado | erro
  erro text,
  created_at timestamptz not null default now(),
  entregue_em timestamptz,
  unique (company_id, numero)
);

-- Só o servidor (service role) lê e escreve: as imagens e os textos não aparecem para o navegador.
alter table public.prospeccao_pendente enable row level security;
