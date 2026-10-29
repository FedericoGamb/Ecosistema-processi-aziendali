-- Anagrafica di manutentori e coproprietari degli stampi
create table public.stampi_soggetti (
  id text primary key default gen_random_uuid()::text,
  tipo text not null check (tipo in ('manutentore','coproprietario')),
  nome text not null,
  referente text not null default '',
  telefono text not null default '',
  email text not null default '',
  note text not null default '',
  creato timestamptz not null default now(),
  aggiornato timestamptz not null default now()
);
create unique index stampi_soggetti_unico on public.stampi_soggetti (tipo, lower(nome));

alter table public.stampi_soggetti enable row level security;
create policy "stampi_soggetti: lettura" on public.stampi_soggetti for select to authenticated using (public.ruolo() in ('admin','operatore'));
create policy "stampi_soggetti: inserimento" on public.stampi_soggetti for insert to authenticated with check (public.ruolo() in ('admin','operatore'));
create policy "stampi_soggetti: modifica" on public.stampi_soggetti for update to authenticated using (public.ruolo() in ('admin','operatore')) with check (public.ruolo() in ('admin','operatore'));
create policy "stampi_soggetti: eliminazione admin" on public.stampi_soggetti for delete to authenticated using (public.ruolo() = 'admin');

create trigger registro_stampi_soggetti after insert or update or delete on public.stampi_soggetti
  for each row execute function public.registra_modifica();

-- i nomi già usati negli stampi diventano anagrafiche
insert into public.stampi_soggetti (tipo, nome)
select distinct on (lower(trim(x.nome))) x.tipo, trim(x.nome) from (
  select 'coproprietario' tipo, coproprietario nome from public.stampi where coalesce(trim(coproprietario),'') <> ''
  union all select 'coproprietario', destinazione from public.stampi where stato = 'coproprietario' and coalesce(trim(destinazione),'') <> ''
  union all select 'manutentore', destinazione from public.stampi where stato = 'manutenzione' and coalesce(trim(destinazione),'') <> ''
) x
on conflict do nothing;

alter publication supabase_realtime add table public.stampi_soggetti;
