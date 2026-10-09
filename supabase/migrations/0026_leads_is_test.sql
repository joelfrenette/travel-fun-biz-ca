-- Test leads (made-up people used to try the forms) must never count in any report, dashboard or KPI.
-- Flagged at save time by lib/test-data.ts; this adds the flag and marks the ones already saved.
alter table leads add column if not exists is_test boolean not null default false;

update leads
set is_test = true
where email ~* '@example\.(com|org|net)$'
   or email ~* '\.(test|invalid|localhost)$'
   or name ilike 'TEST LEAD%';
