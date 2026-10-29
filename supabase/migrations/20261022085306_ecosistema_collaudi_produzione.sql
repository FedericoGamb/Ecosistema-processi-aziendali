-- Prodotti: ritmo giornaliero, postazioni di riferimento, matricola dei collaudi
alter table public.anagrafica add column if not exists ritmo numeric;
alter table public.anagrafica add column if not exists postazioni integer;
alter table public.anagrafica add column if not exists matricola text;

-- Portale Collaudi e Seriali: un documento per riga, ver cresce a ogni modifica
create table if not exists public.portale_doc (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  ver        bigint      not null default 1,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);

create or replace function public.portale_doc_ver() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.ver := old.ver + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists portale_doc_ver on public.portale_doc;
create trigger portale_doc_ver before update on public.portale_doc
  for each row execute function public.portale_doc_ver();

alter table public.portale_doc enable row level security;
drop policy if exists "portale_doc: gestione admin" on public.portale_doc;
create policy "portale_doc: gestione admin" on public.portale_doc
  for all to authenticated
  using (public.ruolo() = 'admin')
  with check (public.ruolo() = 'admin');

revoke all on public.portale_doc from anon;
grant select, insert, update, delete on public.portale_doc to authenticated;
