alter table public.stampi add column if not exists presse_predisposte text not null default '';
comment on column public.stampi.presse_predisposte is 'Numeri delle presse per cui lo stampo è predisposto, separati da virgola (es. 4,7)';
