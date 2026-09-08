\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);
\ir ../budget-observed-overrun-cases.sql
select extensions.pass('observed overrun preserves scope, floor, unknown usage, idempotency and future admission limits');
select * from extensions.finish();
rollback;
