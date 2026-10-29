-- L'operatore può correggere (cancellare e reinserire) le proprie registrazioni appena fatte: solo entro 15 minuti dall'invio.
create or replace function public.correggi_registrazioni(ids text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if public.ruolo() not in ('admin', 'operatore') then raise exception 'Non autorizzato'; end if;
  delete from public.registrazioni
   where id = any(ids)
     and (public.ruolo() = 'admin' or creato > now() - interval '15 minutes');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.correggi_registrazioni(text[]) from public, anon;
grant execute on function public.correggi_registrazioni(text[]) to authenticated;
