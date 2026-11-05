-- Suporte a múltiplos provedores (jev e Claude) com tokens e custo por decisão.
alter table public.jev_decisoes
  add column if not exists provedor text not null default 'jev',
  add column if not exists tokens_entrada integer,
  add column if not exists tokens_saida integer,
  add column if not exists custo_usd numeric(12, 8);
