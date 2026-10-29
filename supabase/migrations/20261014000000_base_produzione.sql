-- Base di Gestione Produzione: ruoli, anagrafiche e registrazioni di turno.
-- Ricostruita dallo schema in produzione (le tabelle iniziali erano state create dall'editor SQL).

-- Ruolo dell'utente dal JWT: app_metadata.ruolo = 'admin' | 'operatore'
create or replace function public.ruolo() returns text
language sql stable
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'ruolo', '') $$;

-- Anagrafiche: operatori (a = nome, b = cognome), prodotti (a = codice, b = descrizione),
-- cause di scarto e di fermo (a = codice, b = descrizione).
-- Per prodotti e cause di scarto il reparto è un prefisso di b: "stampaggio::", "officina::", "entrambi::".
create table if not exists public.anagrafica (
  id     text primary key,
  tipo   text not null check (tipo in ('operatori', 'prodotti', 'scarti', 'fermi')),
  a      text not null,
  b      text not null default '',
  creato timestamptz not null default now()
);

-- Registrazioni di fine turno: pezzi prodotti, scarti con causa, fermi con durata
create table if not exists public.registrazioni (
  id         text primary key,
  ts         timestamptz not null,
  operatore  text not null,
  prodotto   text not null,
  tipo       text not null check (tipo in ('Produzione', 'Scarto', 'Fermo')),
  causa      text not null default '',
  pezzi      integer,
  durata_sec integer,
  creato     timestamptz not null default now()
);
create index if not exists registrazioni_ts_idx on public.registrazioni (ts desc);

alter table public.anagrafica enable row level security;
alter table public.registrazioni enable row level security;

create policy "anagrafica: lettura" on public.anagrafica
  for select to authenticated using (public.ruolo() in ('admin', 'operatore'));
create policy "anagrafica: gestione admin" on public.anagrafica
  for all to authenticated using (public.ruolo() = 'admin') with check (public.ruolo() = 'admin');

create policy "registrazioni: inserimento" on public.registrazioni
  for insert to authenticated with check (public.ruolo() in ('admin', 'operatore'));
create policy "registrazioni: lettura admin" on public.registrazioni
  for select to authenticated using (public.ruolo() = 'admin');
create policy "registrazioni: eliminazione admin" on public.registrazioni
  for delete to authenticated using (public.ruolo() = 'admin');

revoke all on public.anagrafica, public.registrazioni from anon;
grant select, insert, update, delete on public.anagrafica, public.registrazioni to authenticated;
