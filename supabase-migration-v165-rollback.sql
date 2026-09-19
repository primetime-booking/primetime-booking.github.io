begin;
set local search_path=public,extensions,pg_catalog;

drop function if exists public.get_public_minuta_available_slots_compact_v165(text,uuid,uuid,date,date);
drop function if exists public.get_available_slots_compact_v165(uuid,date,date,uuid);

commit;
