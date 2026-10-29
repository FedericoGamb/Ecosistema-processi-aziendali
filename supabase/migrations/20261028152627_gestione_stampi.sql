-- Gestione Stampi: anagrafica con posizione in magazzino, stato e storico dei movimenti
create table public.stampi (
  id text primary key,
  codice text,
  nome text not null,
  descrizione text default '',
  zona text default '',
  scaffale text default '',
  ripiano text default '',
  coproprietario text default '',
  note text default '',
  stato text not null default 'magazzino' check (stato in ('magazzino','pressa','manutenzione','coproprietario')),
  pressa text default '',
  destinazione text default '',
  stato_dal timestamptz not null default now(),
  creato timestamptz not null default now(),
  aggiornato timestamptz not null default now()
);
create unique index stampi_codice_unico on public.stampi (lower(codice)) where codice is not null and codice <> '';

create table public.stampi_movimenti (
  id text primary key default gen_random_uuid()::text,
  stampo_id text not null,
  nome text default '',
  codice text default '',
  tipo text not null default 'stato',
  da text default '',
  da_pressa text default '',
  da_dest text default '',
  a text not null,
  pressa text default '',
  dest text default '',
  dettaglio text default '',
  utente text default coalesce(auth.jwt() ->> 'email', ''),
  data timestamptz not null default now()
);
create index stampi_movimenti_stampo on public.stampi_movimenti (stampo_id, data desc);
create index stampi_movimenti_data on public.stampi_movimenti (data desc);

alter table public.stampi enable row level security;
alter table public.stampi_movimenti enable row level security;

create policy "stampi: lettura" on public.stampi for select to authenticated using (public.ruolo() in ('admin','operatore'));
create policy "stampi: inserimento" on public.stampi for insert to authenticated with check (public.ruolo() in ('admin','operatore'));
create policy "stampi: modifica" on public.stampi for update to authenticated using (public.ruolo() in ('admin','operatore')) with check (public.ruolo() in ('admin','operatore'));
create policy "stampi: eliminazione admin" on public.stampi for delete to authenticated using (public.ruolo() = 'admin');

create policy "stampi_movimenti: lettura" on public.stampi_movimenti for select to authenticated using (public.ruolo() in ('admin','operatore'));
create policy "stampi_movimenti: inserimento" on public.stampi_movimenti for insert to authenticated with check (public.ruolo() in ('admin','operatore'));
create policy "stampi_movimenti: eliminazione admin" on public.stampi_movimenti for delete to authenticated using (public.ruolo() = 'admin');

create trigger registro_stampi after insert or update or delete on public.stampi
  for each row execute function public.registra_modifica();

-- Cambio di stato atomico: aggiorna lo stampo e scrive il movimento
create or replace function public.stampi_cambia_stato(
  p_id text, p_stato text, p_pressa text default '', p_dest text default '', p_dettaglio text default '',
  p_zona text default null, p_scaffale text default null, p_ripiano text default null, p_copro text default null)
returns public.stampi
language plpgsql
security invoker
set search_path to ''
as $$
declare s public.stampi;
begin
  if public.ruolo() not in ('admin','operatore') then raise exception 'Non autorizzato'; end if;
  select * into s from public.stampi where id = p_id for update;
  if not found then raise exception 'Stampo non trovato'; end if;
  insert into public.stampi_movimenti (stampo_id, nome, codice, tipo, da, da_pressa, da_dest, a, pressa, dest, dettaglio)
  values (s.id, s.nome, coalesce(s.codice,''), 'stato', s.stato, coalesce(s.pressa,''), coalesce(s.destinazione,''), p_stato,
          case when p_stato = 'pressa' then coalesce(p_pressa,'') else '' end,
          case when p_stato = 'coproprietario' then coalesce(p_dest,'') else '' end,
          coalesce(p_dettaglio,''));
  update public.stampi set
    stato = p_stato,
    pressa = case when p_stato = 'pressa' then coalesce(p_pressa,'') else '' end,
    destinazione = case when p_stato in ('coproprietario','manutenzione') then coalesce(p_dest,'') else '' end,
    zona = coalesce(p_zona, zona), scaffale = coalesce(p_scaffale, scaffale), ripiano = coalesce(p_ripiano, ripiano),
    coproprietario = coalesce(p_copro, coproprietario),
    stato_dal = now(), aggiornato = now()
  where id = p_id
  returning * into s;
  return s;
end $$;

alter publication supabase_realtime add table public.stampi, public.stampi_movimenti;
