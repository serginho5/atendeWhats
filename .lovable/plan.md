## Módulo Financeiro AtendeZap

### Princípios

- **Plug-and-play opcional**: empresa pode habilitar/desabilitar no clique. Se desligado, menu some, automação não roda, nada interfere no fluxo atual.
- **Plano**: só Pro e Business. Starter vê CTA de upgrade. Demo mostra a tela com aviso "disponível no Pro+".
- **Automação leve**: quando um card vai pra stage do tipo `ganho`, gera 1 lançamento de receita (pendente, vencimento = hoje+7 por padrão configurável). Idempotente por `crm_card_id`.
- **Realista pra PME brasileira**: categorias, formas de pagamento (PIX/boleto/cartão/dinheiro), competência vs caixa, status (pendente/pago/atrasado/cancelado), exportação CSV.

### Arquitetura

```text
src/routes/app/financeiro.tsx              → Layout com tabs (Visão, Receber, Pagar, Categorias)
src/routes/app/financeiro.index.tsx        → Dashboard (KPIs + gráficos)
src/routes/app/financeiro.receber.tsx     → Contas a receber
src/routes/app/financeiro.pagar.tsx       → Contas a pagar
src/routes/app/financeiro.categorias.tsx  → CRUD categorias
src/routes/demo/financeiro.tsx            → Demo com badge "Pro+"

src/lib/financeiro.functions.ts           → Server fns (list/create/update/pay/delete/kpis/export)
src/components/financeiro/                → LancamentoDrawer, KpiGrid, FluxoChart, CategoriaDialog
```

### Banco (1 migration)

- `fin_categoria` (company_id, nome, tipo `receita|despesa`, cor, ativo)
- `fin_lancamento` (company_id, tipo, descricao, valor_cents, categoria_id, forma_pagamento, status, vencimento, pago_em, competencia, crm_card_id?, contato_numero?, observacao, anexo_url?, created_by)
- Coluna em `company`: `financeiro_ativo boolean default false`
- Trigger `tg_fin_auto_receita_on_ganho`: ao mover card pra stage `ganho` e `financeiro_ativo=true` e plano permitir → insere lançamento receita pendente. Idempotente: `unique(company_id, crm_card_id) where crm_card_id is not null`.
- 4 categorias seed por empresa que ativar (Vendas, Marketing, Folha, Operacional)
- RLS por `company_id` via `has_company_access`, GRANTs pra `authenticated` + `service_role`

### Plano

Adicionar em `src/lib/plan-features.ts`:
```ts
financeiro: boolean  // starter:false, pro:true, business:true
```

### UI

**Dashboard financeiro**:
- KPIs: Receita do mês, Despesa do mês, Saldo, A receber (pendente), A pagar (pendente), Atrasados
- Gráfico área 6 meses (receitas vs despesas)
- Lista "Próximos vencimentos" (7 dias)
- Top 5 categorias de despesa

**Contas (receber/pagar)**:
- Tabela com filtros (status, período, categoria, busca)
- Ações: marcar pago, editar, excluir
- Botão "Novo lançamento" → drawer com form
- Badge no item que veio do CRM (link pro card)

**Configurações** (em `/app/configuracoes`):
- Toggle "Ativar módulo financeiro" (visível só Pro+, com CTA upgrade no Starter)
- Quando liga: define dias padrão de vencimento para receitas automáticas do CRM

### Navegação

- `app-shell.tsx`: nova seção "Financeiro" com item "Financeiro" (icon `Wallet`), só aparece se `company.financeiro_ativo && features.financeiro && isAdmin`
- Mobile nav: substitui "Agente" por "Financeiro" se ativo (configurável depois)

### Demo

- `/demo/financeiro` com dados mockados realistas (já vou popular)
- Badge no topo: "🔒 Disponível nos planos Pro e Business"
- Sidebar do demo ganha o item

### Segurança/Performance

- Server fns com `requireSupabaseAuth` + checagem `has_company_access`
- Mutations validam plano server-side (pra impedir bypass)
- Índices: `(company_id, status, vencimento)`, `(company_id, tipo, competencia)`
- KPIs agregados via SQL (não trazer todos os lançamentos pro front)

### Entregas (ordem)

1. Migration (tabelas + trigger + coluna + features)
2. plan-features.ts + `financeiro` flag
3. financeiro.functions.ts
4. Rotas /app/financeiro/* + componentes
5. Toggle em /app/configuracoes
6. AppShell item de menu condicional
7. /demo/financeiro com mock + badge plano
8. Help tips (?) consistente com o resto do app

Tudo isolado: se algo falhar não quebra atendimento/CRM.