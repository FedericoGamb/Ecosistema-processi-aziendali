-- Search path fisso sulla funzione dei ruoli (consiglio dell'advisor di sicurezza di Supabase)
alter function public.ruolo() set search_path = '';
