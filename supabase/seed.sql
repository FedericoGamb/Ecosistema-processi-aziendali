-- Dati di esempio (inventati) per un progetto Supabase nuovo.
-- Gli utenti si creano da Authentication e ricevono il ruolo in app_metadata, per esempio:
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"ruolo":"admin"}' where email = 'admin@example.com';
--   update auth.users set raw_app_meta_data = raw_app_meta_data || '{"ruolo":"operatore"}' where email = 'operatore@example.com';
insert into public.anagrafica (id, tipo, a, b, ritmo, postazioni, matricola) values
('op-mario', 'operatori', 'Mario', 'stampaggio::Rossi', null, null, null),
('op-laura', 'operatori', 'Laura', 'officina::Bianchi', null, null, null),
('op-luca', 'operatori', 'Luca', 'stampaggio::Verdi', null, null, null),
('op-sara', 'operatori', 'Sara', 'officina::Neri', null, null, null),
('pr-100210', 'prodotti', 'ST100210', 'stampaggio::Coperchio scatola di derivazione', 900, null, '100210'),
('pr-100220', 'prodotti', 'ST100220', 'stampaggio::Base scatola di derivazione', 850, null, '100220'),
('pr-100200', 'prodotti', 'PF100200', 'officina::Quadro in vetroresina 600x400', 40, 2, '100200'),
('pr-100300', 'prodotti', 'PF100300', 'officina::Morsettiera di distribuzione', 120, 1, '100300'),
('sc-bave', 'scarti', 'S01', 'stampaggio::Bave di stampaggio', null, null, null),
('sc-rotture', 'scarti', 'S02', 'stampaggio::Rottura in estrazione', null, null, null),
('sc-montaggio', 'scarti', 'S10', 'officina::Errore di montaggio', null, null, null),
('fe-attrezzaggio', 'fermi', 'F01', 'Cambio stampo / attrezzaggio', null, null, null),
('fe-guasto', 'fermi', 'F02', 'Guasto macchina', null, null, null),
('fe-materiale', 'fermi', 'F03', 'Mancanza materiale', null, null, null)
on conflict (id) do nothing;
