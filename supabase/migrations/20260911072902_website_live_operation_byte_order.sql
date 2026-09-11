-- Opaque provider IDs use UTF8 byte ordering, independent of the database locale.
-- No records are rewritten and literal transcript assembly remains temporal.
begin;
do $live_operation_byte_order$
declare definition text;
  before text:='select array_agg(x order by x) into refs from (select distinct unnest(p_source_ids) x) s;';
  after text:='select array_agg(x order by x collate "C") into refs from (select distinct unnest(p_source_ids) x) s;';
begin
  select pg_get_functiondef('public.commit_website_live_decision(uuid,uuid,uuid,text,text,bigint,bigint,text,text,text,text[],text)'::regprocedure) into definition;
  if position(before in definition)=0 then raise exception 'live_operation_source_order_contract_missing';end if;
  execute replace(definition,before,after);
end;
$live_operation_byte_order$;
commit;
