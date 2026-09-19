import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const moduleName = process.env.MINUTA_PGLITE_MODULE || '@electric-sql/pglite';
const moduleSpecifier = /^[A-Za-z]:[\\/]/.test(moduleName) ? pathToFileURL(moduleName).href : moduleName;
const { PGlite } = await import(moduleSpecifier);
const db = new PGlite();
const migration = readFileSync(new URL('../supabase-migration-v165.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase-migration-v165-rollback.sql', import.meta.url), 'utf8');

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;

  create or replace function public.get_available_slots_v101(
    p_service uuid,p_start date,p_end date,p_ignore_booking uuid default null
  ) returns table(booking_date date,booking_time time without time zone)
  language sql stable as $$
    select day::date,(time '00:00' + make_interval(mins=>slot*5))::time
    from generate_series(p_start,p_end,interval '1 day') day
    cross join generate_series(0,119) slot
    order by 1,2;
  $$;

  create or replace function public.get_public_minuta_available_slots_v101(
    p_slug text,p_location uuid,p_service uuid,p_start date,p_end date
  ) returns table(booking_date date,booking_time time without time zone)
  language sql stable as $$
    select * from public.get_available_slots_v101(p_service,p_start,p_end,null);
  $$;
`);

await db.exec(migration);
await db.exec(migration);

const personal = await db.query(`
  select count(*)::integer compact_rows,
    coalesce(sum(cardinality(booking_times)),0)::integer slot_count,
    min(booking_date)::text first_date,max(booking_date)::text last_date
  from public.get_available_slots_compact_v165(
    '11111111-1111-1111-1111-111111111111','2099-09-01','2099-09-14',null
  );
`);
assert.deepEqual(personal.rows[0], {
  compact_rows:14,
  slot_count:1680,
  first_date:'2099-09-01',
  last_date:'2099-09-14'
});

const exact = await db.query(`
  with compact as (
    select grouped.booking_date,unnest(grouped.booking_times) booking_time
    from public.get_available_slots_compact_v165(
      '11111111-1111-1111-1111-111111111111','2099-09-01','2099-09-14',null
    ) grouped
  ), legacy as (
    select * from public.get_available_slots_v101(
      '11111111-1111-1111-1111-111111111111','2099-09-01','2099-09-14',null
    )
  )
  select not exists((select * from compact except select * from legacy)
    union all (select * from legacy except select * from compact)) exact;
`);
assert.equal(exact.rows[0].exact, true, 'Compact personal RPC must preserve the exact authoritative v101 slots');

const team = await db.query(`
  select count(*)::integer compact_rows,coalesce(sum(cardinality(booking_times)),0)::integer slot_count
  from public.get_public_minuta_available_slots_compact_v165(
    'org-a','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','2099-09-01','2099-09-14'
  );
`);
assert.deepEqual(team.rows[0], { compact_rows:14, slot_count:1680 });

await db.exec(rollback);
const removed = await db.query(`select
  to_regprocedure('public.get_available_slots_compact_v165(uuid,date,date,uuid)') is null personal,
  to_regprocedure('public.get_public_minuta_available_slots_compact_v165(text,uuid,uuid,date,date)') is null team;`);
assert.deepEqual(removed.rows[0], { personal:true, team:true });

await db.close();
console.log('availability compact v165 PGlite test: OK');
