-- Registro de auditoria das decisões do jev (somente a Edge Function grava, via service role).
create table if not exists public.jev_decisoes (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  modelo text not null,
  vendedores jsonb not null,
  probabilidades jsonb,
  vencedor text,
  justificativa text,
  latencia_ms integer,
  erro text,
  origem_hash text
);

create index if not exists jev_decisoes_origem_criado_idx
  on public.jev_decisoes (origem_hash, criado_em desc);

-- RLS ligado e sem políticas: anon e authenticated não leem nem escrevem.
alter table public.jev_decisoes enable row level security;
