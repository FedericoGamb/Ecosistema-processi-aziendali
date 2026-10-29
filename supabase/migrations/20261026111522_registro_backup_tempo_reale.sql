-- Rilascio 1: registro modifiche, backup notturno via email (Resend), aggiornamenti in tempo reale
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------- Registro delle modifiche ----------
create table if not exists public.registro_modifiche (
  id bigserial primary key,
  ts timestamptz not null default now(),
  utente text not null default '',
  tabella text not null,
  chiave text not null,
  azione text not null,
  prima jsonb,
  dopo jsonb
);
create index if not exists registro_modifiche_ts on public.registro_modifiche (ts desc);
create index if not exists registro_modifiche_chiave on public.registro_modifiche (tabella, chiave);
alter table public.registro_modifiche enable row level security;
drop policy if exists "registro: lettura admin" on public.registro_modifiche;
create policy "registro: lettura admin" on public.registro_modifiche for select to authenticated using (public.ruolo() = 'admin');

-- Trigger generico: salva solo i campi cambiati; un errore nel registro non blocca mai la scrittura
create or replace function public.registra_modifica() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_user text; v_key text; v_old jsonb; v_new jsonb; v_po jsonb := '{}'::jsonb; v_pn jsonb := '{}'::jsonb; f text;
begin
  begin
    v_user := coalesce(nullif(auth.jwt() ->> 'email', ''), case when auth.role() = 'service_role' then 'sistema' else current_user end);
    if TG_TABLE_NAME = 'portale_doc' then
      if TG_OP <> 'INSERT' then v_old := OLD.data; end if;
      if TG_OP <> 'DELETE' then v_new := NEW.data; end if;
      v_key := case when TG_OP = 'DELETE' then OLD.col || '/' || OLD.id else NEW.col || '/' || NEW.id end;
    else
      if TG_OP <> 'INSERT' then v_old := to_jsonb(OLD); end if;
      if TG_OP <> 'DELETE' then v_new := to_jsonb(NEW); end if;
      v_key := case when TG_OP = 'DELETE' then OLD.id else NEW.id end;
    end if;
    if TG_OP = 'UPDATE' then
      for f in select jsonb_object_keys(coalesce(v_old, '{}'::jsonb) || coalesce(v_new, '{}'::jsonb)) loop
        if f in ('updatedAt', 'ver', 'updated_at') then continue; end if;
        if (v_old -> f) is distinct from (v_new -> f) then
          v_po := v_po || jsonb_build_object(f, v_old -> f);
          v_pn := v_pn || jsonb_build_object(f, v_new -> f);
        end if;
      end loop;
      if v_po = '{}'::jsonb and v_pn = '{}'::jsonb then return null; end if;
    else
      v_po := v_old; v_pn := v_new;
    end if;
    insert into public.registro_modifiche (utente, tabella, chiave, azione, prima, dopo)
    values (v_user, TG_TABLE_NAME, v_key, TG_OP, case when TG_OP = 'INSERT' then null else v_po end, case when TG_OP = 'DELETE' then null else v_pn end);
  exception when others then
    null;
  end;
  return null;
end $$;
revoke all on function public.registra_modifica() from public, anon, authenticated;

drop trigger if exists registro_portale on public.portale_doc;
create trigger registro_portale after insert or update or delete on public.portale_doc for each row execute function public.registra_modifica();
drop trigger if exists registro_anagrafica on public.anagrafica;
create trigger registro_anagrafica after insert or update or delete on public.anagrafica for each row execute function public.registra_modifica();
drop trigger if exists registro_registrazioni on public.registrazioni;
create trigger registro_registrazioni after update or delete on public.registrazioni for each row execute function public.registra_modifica();

-- ---------- Backup notturno ----------
create table if not exists public.impostazioni (k text primary key, v text not null default '');
alter table public.impostazioni enable row level security;

create table if not exists public.backup_esiti (
  id bigserial primary key,
  ts timestamptz not null default now(),
  ok boolean not null,
  origine text not null default '',
  dettaglio text not null default ''
);
alter table public.backup_esiti enable row level security;
drop policy if exists "backup: lettura admin" on public.backup_esiti;
create policy "backup: lettura admin" on public.backup_esiti for select to authenticated using (public.ruolo() = 'admin');

-- Token del compito pianificato e chiave Resend restano nel Vault, mai nel codice
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'backup_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'backup_token', 'Token del backup notturno');
  end if;
end $$;

-- Letta solo dalla Edge Function (service_role)
create or replace function public.backup_segreti(t text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tok text; v_chiave text; v_dest text; v_mitt text;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'backup_token';
  select decrypted_secret into v_chiave from vault.decrypted_secrets where name = 'resend_api_key';
  select v into v_dest from public.impostazioni where k = 'backup_destinatario';
  select v into v_mitt from public.impostazioni where k = 'backup_mittente';
  return jsonb_build_object('token_ok', coalesce(t, '') <> '' and t = v_tok, 'chiave', v_chiave,
    'destinatario', coalesce(nullif(v_dest, ''), 'backup@example.com'), 'mittente', nullif(v_mitt, ''));
end $$;
revoke all on function public.backup_segreti(text) from public, anon, authenticated;
grant execute on function public.backup_segreti(text) to service_role;

-- Stato del backup per la pagina di impostazioni (solo admin; la chiave non torna mai al browser)
create or replace function public.backup_stato() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public.ruolo() <> 'admin' then raise exception 'Solo l''amministratore'; end if;
  return jsonb_build_object(
    'chiave', exists (select 1 from vault.secrets where name = 'resend_api_key'),
    'destinatario', coalesce((select nullif(v, '') from public.impostazioni where k = 'backup_destinatario'), 'backup@example.com'),
    'mittente', (select nullif(v, '') from public.impostazioni where k = 'backup_mittente'),
    'esiti', coalesce((select jsonb_agg(x order by x.ts desc) from (select ts, ok, origine, dettaglio from public.backup_esiti order by ts desc limit 10) x), '[]'::jsonb));
end $$;

create or replace function public.backup_imposta(chiave text default null, destinatario text default null, mittente text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if public.ruolo() <> 'admin' then raise exception 'Solo l''amministratore può cambiare il backup'; end if;
  if coalesce(trim(chiave), '') <> '' then
    select id into v_id from vault.secrets where name = 'resend_api_key';
    if v_id is null then perform vault.create_secret(trim(chiave), 'resend_api_key', 'Chiave API Resend per il backup');
    else perform vault.update_secret(v_id, trim(chiave)); end if;
  end if;
  if destinatario is not null then
    insert into public.impostazioni (k, v) values ('backup_destinatario', trim(destinatario)) on conflict (k) do update set v = excluded.v;
  end if;
  if mittente is not null then
    insert into public.impostazioni (k, v) values ('backup_mittente', trim(mittente)) on conflict (k) do update set v = excluded.v;
  end if;
  return public.backup_stato();
end $$;
revoke all on function public.backup_imposta(text, text, text) from public, anon;
revoke all on function public.backup_stato() from public, anon;
grant execute on function public.backup_imposta(text, text, text) to authenticated;
grant execute on function public.backup_stato() to authenticated;

-- Compiti pianificati: backup alle 01:30, pulizia del registro il primo del mese.
-- Sostituisci <PROJECT_REF> con il riferimento del tuo progetto Supabase prima di applicare la migrazione.
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('backup-notturno', 'pulizia-registro');
end $$;
select cron.schedule('backup-notturno', '30 1 * * *', $cron$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/backup-notturno',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-backup-token', (select decrypted_secret from vault.decrypted_secrets where name = 'backup_token')),
    body := '{"origine":"notte"}'::jsonb,
    timeout_milliseconds := 60000);
$cron$);
select cron.schedule('pulizia-registro', '0 3 1 * *', $cron$
  delete from public.registro_modifiche where ts < now() - interval '400 days';
  delete from public.backup_esiti where ts < now() - interval '400 days';
$cron$);

-- ---------- Tempo reale per il portale ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'portale_doc') then
    alter publication supabase_realtime add table public.portale_doc;
  end if;
end $$;
