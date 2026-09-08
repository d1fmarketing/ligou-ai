\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);
\ir optional-daily-budget-cases.inc
select extensions.pass('Optional daily caps preserve finite limits, tenant scope, idempotency and usage accounting');
select * from extensions.finish();
rollback;
