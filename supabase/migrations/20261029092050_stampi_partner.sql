-- Nuovo stato "partner" per stampi e soggetti
alter table public.stampi drop constraint stampi_stato_check;
alter table public.stampi add constraint stampi_stato_check check (stato in ('magazzino','pressa','manutenzione','coproprietario','partner'));
alter table public.stampi_soggetti drop constraint stampi_soggetti_tipo_check;
alter table public.stampi_soggetti add constraint stampi_soggetti_tipo_check check (tipo in ('manutentore','coproprietario','partner'));

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
          case when p_stato in ('coproprietario','partner','manutenzione') then coalesce(p_dest,'') else '' end,
          coalesce(p_dettaglio,''));
  update public.stampi set
    stato = p_stato,
    pressa = case when p_stato = 'pressa' then coalesce(p_pressa,'') else '' end,
    destinazione = case when p_stato in ('coproprietario','manutenzione','partner') then coalesce(p_dest,'') else '' end,
    zona = coalesce(p_zona, zona), scaffale = coalesce(p_scaffale, scaffale), ripiano = coalesce(p_ripiano, ripiano),
    coproprietario = coalesce(p_copro, coproprietario),
    stato_dal = now(), aggiornato = now()
  where id = p_id
  returning * into s;
  return s;
end $$;
