begin;
set local search_path=public,extensions,pg_catalog;

do $guard$
begin
  if to_regprocedure('public.get_available_slots_v101(uuid,date,date,uuid)') is null
     or to_regprocedure('public.get_public_minuta_available_slots_v101(text,uuid,uuid,date,date)') is null then
    raise exception using errcode='55000',message='v165_compact_availability_prerequisites_missing';
  end if;
end
$guard$;

create or replace function public.get_available_slots_compact_v165(
  p_service uuid,
  p_start date,
  p_end date,
  p_ignore_booking uuid default null
)
returns table(booking_date date, booking_times time without time zone[])
language sql
stable
security definer
set search_path to ''
as $$
  select slot.booking_date,
    array_agg(slot.booking_time order by slot.booking_time) as booking_times
  from public.get_available_slots_v101(p_service,p_start,p_end,p_ignore_booking) slot
  group by slot.booking_date
  order by slot.booking_date;
$$;

revoke all on function public.get_available_slots_compact_v165(uuid,date,date,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_available_slots_compact_v165(uuid,date,date,uuid)
  to anon,authenticated;

create or replace function public.get_public_minuta_available_slots_compact_v165(
  p_slug text,
  p_location uuid,
  p_service uuid,
  p_start date,
  p_end date
)
returns table(booking_date date, booking_times time without time zone[])
language sql
stable
security definer
set search_path to ''
as $$
  select slot.booking_date,
    array_agg(slot.booking_time order by slot.booking_time) as booking_times
  from public.get_public_minuta_available_slots_v101(p_slug,p_location,p_service,p_start,p_end) slot
  group by slot.booking_date
  order by slot.booking_date;
$$;

revoke all on function public.get_public_minuta_available_slots_compact_v165(text,uuid,uuid,date,date)
  from public,anon,authenticated,service_role;
grant execute on function public.get_public_minuta_available_slots_compact_v165(text,uuid,uuid,date,date)
  to anon,authenticated;

commit;
