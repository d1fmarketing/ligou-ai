begin;

-- Application-owned interview speech and owner approval evidence. No rule,
-- power, tenant generation, canonical Discovery draft, or provider mutation.
create table public.website_interview_summaries (
  id uuid primary key,
  interview_id uuid not null references public.website_interviews(interview_id),
  tenant_id uuid not null references public.tenants(id),
  call_id uuid not null references public.calls(id),
  revision bigint not null, store_version bigint not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  agenda_receipt_id uuid not null references public.receipts(id),
  draft_id uuid not null references public.company_discovery_onboarding_drafts(id),
  parts jsonb not null,
  summary_hash text not null check(summary_hash ~ '^[a-f0-9]{64}$'),
  receipt_id uuid not null references public.receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(interview_id,digest,store_version)
);
create table public.website_interview_speech (
  call_id uuid not null references public.website_interview_calls(call_id),
  action_id text not null check(action_id ~ '^[a-f0-9]{64}$'),
  tenant_id uuid not null references public.tenants(id),
  interview_id uuid not null references public.website_interviews(interview_id),
  digest text not null, action jsonb not null, speech_slot text not null,
  summary_id uuid references public.website_interview_summaries(id),
  part_index integer, clarification_turn_id text,
  status text not null check(status in ('preparing','ready','played','failed','superseded')),
  payload jsonb check(payload is null or octet_length(payload::text)<=2200000),
  ready_receipt_id uuid references public.receipts(id),
  played_receipt_id uuid references public.receipts(id),
  failure_receipt_id uuid references public.receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  played_at timestamptz,
  primary key(call_id,action_id), unique(call_id,digest,speech_slot)
);
create unique index website_interview_one_outstanding_speech on public.website_interview_speech(call_id) where status in ('preparing','ready');
create index website_interview_speech_summary on public.website_interview_speech(summary_id,part_index);
create table public.website_interview_approvals (
  interview_id uuid primary key references public.website_interviews(interview_id),
  tenant_id uuid not null references public.tenants(id),
  call_id uuid not null references public.calls(id),
  summary_id uuid not null references public.website_interview_summaries(id),
  provider_item_id text not null,
  owner_text text not null,
  receipt_id uuid not null unique references public.receipts(id),
  finalized_draft jsonb not null check(octet_length(finalized_draft::text)<=6291456),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(call_id,provider_item_id) references public.website_interview_owner_turns(call_id,provider_item_id)
);
create table public.website_interview_fact_batches (
  call_id uuid not null references public.website_interview_calls(call_id),
  provider_item_id text not null,
  tenant_id uuid not null references public.tenants(id),
  interview_id uuid not null references public.website_interviews(interview_id),
  agenda_receipt_id uuid not null references public.receipts(id),
  owner_text text not null, coverage_refs jsonb not null, facts jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(call_id,provider_item_id),
  foreign key(call_id,provider_item_id) references public.website_interview_owner_turns(call_id,provider_item_id)
);
do $$ declare v_table text; begin
  foreach v_table in array array['website_interview_summaries','website_interview_speech','website_interview_approvals','website_interview_fact_batches'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on table public.%I to service_role',v_table);
    execute format('create index %I on public.%I(tenant_id)',v_table||'_tenant',v_table);
    if v_table<>'website_interview_speech' then execute format('create trigger %I before update or delete on public.%I for each row execute function public.block_mutation()',v_table||'_append_only',v_table); end if;
  end loop;
end $$;

create function public.website_interview_current(p_owner uuid,p_call uuid,p_request uuid,p_active boolean default true) returns public.website_interviews
language plpgsql security definer set search_path='' as $$ declare v_tenant uuid; v_i public.website_interviews; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request,p_active);
  select i.* into v_i from public.website_interviews i join public.website_interview_calls c on c.interview_id=i.interview_id
    where i.current_call_id=p_call and c.call_id=p_call and c.request_id=p_request and i.tenant_id=v_tenant for update of i;
  if v_i.interview_id is null then raise exception 'interview_not_current'; end if;
  return v_i;
end $$;

create function public.website_interview_evidence_guard() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.agenda is distinct from old.agenda and exists(select 1 from public.website_interview_approvals where interview_id=old.interview_id) then raise exception 'interview_already_approved'; end if;
  if new.agenda is distinct from old.agenda and new.current_call_id=old.current_call_id
    and exists(select 1 from public.website_interview_speech where call_id=old.current_call_id and action->>'kind'='SPEAK_TERMINAL_ERROR') then raise exception 'interview_terminal_speech_latched'; end if;
  if new.digest is distinct from old.digest or new.current_call_id is distinct from old.current_call_id then
    update public.website_interview_speech set status='superseded' where interview_id=old.interview_id and status in ('preparing','ready');
  end if;
  return new;
end $$;
create trigger website_interview_evidence_current before update on public.website_interviews for each row execute function public.website_interview_evidence_guard();

create function public.prepare_website_interview_summary(p_owner uuid,p_call uuid,p_request uuid,p_summary uuid,p_revision bigint,p_store_version bigint,p_digest text,p_receipt uuid,p_parts jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_summaries; v_hash text; v_receipt uuid:=gen_random_uuid(); v_readback jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if v_i.state in ('closing','complete') or exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id) then raise exception 'interview_already_approved'; end if;
  if v_i.db_version is distinct from p_store_version or v_i.digest is distinct from p_digest or v_i.receipt_id is distinct from p_receipt or (v_i.agenda->>'revision')::bigint is distinct from p_revision then raise exception using errcode='40001',message='interview_summary_snapshot_changed'; end if;
  if exists(select 1 from jsonb_array_elements(v_i.agenda->'items'||(v_i.agenda->'candidateOverrides')) x where x->>'status' in ('open','awaiting_clarification')) then raise exception 'interview_summary_queue_unfinished'; end if;
  if p_summary is null or p_parts is null or jsonb_typeof(p_parts)<>'array' or octet_length(p_parts::text)>2097152 then raise exception 'interview_summary_parts_invalid'; end if;
  if jsonb_array_length(p_parts) not between 1 and 2048 or exists(select 1 from jsonb_array_elements(p_parts) x where jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and 4096) then raise exception 'interview_summary_parts_invalid'; end if;
  v_hash:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(p_summary,p_revision,p_digest,p_parts)),'sha256'),'hex');
  select * into v_s from public.website_interview_summaries where id=p_summary;
  if v_s.id is not null then
    if v_s.interview_id<>v_i.interview_id or v_s.call_id<>p_call or v_s.summary_hash<>v_hash or v_s.store_version<>p_store_version then raise exception 'interview_summary_conflict'; end if;
    return jsonb_build_object('summaryId',v_s.id,'summaryHash',v_s.summary_hash,'revision',v_s.revision,'digest',v_s.digest,'parts',v_s.parts,'receiptId',v_s.receipt_id);
  end if;
  v_readback:=jsonb_build_object('summaryId',p_summary,'summaryHash',v_hash,'revision',p_revision,'digest',p_digest,'parts',p_parts,'receiptId',v_receipt);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail) values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-summary:'||p_summary::text,v_hash,v_readback,jsonb_build_object('agendaReceiptId',p_receipt,'storeVersion',p_store_version,'candidateDraftId',v_i.agenda->'binding'->>'draftId'));
  insert into public.website_interview_summaries(id,interview_id,tenant_id,call_id,revision,store_version,digest,agenda_receipt_id,draft_id,parts,summary_hash,receipt_id)
    values(p_summary,v_i.interview_id,v_i.tenant_id,p_call,p_revision,p_store_version,p_digest,p_receipt,(v_i.agenda->'binding'->>'draftId')::uuid,p_parts,v_hash,v_receipt);
  return v_readback;
end $$;

create function public.website_interview_speech_readback(p_call uuid,p_action text,p_claimed boolean default false) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('status',s.status,'claimed',p_claimed,'action',s.action,'payload',s.payload,'noticeId','lsn-'||left(s.action_id,28),'receiptId',coalesce(s.played_receipt_id,s.ready_receipt_id,s.failure_receipt_id)) from public.website_interview_speech s where s.call_id=p_call and s.action_id=p_action;
$$;

-- PG16/17 UTF8; no unaccent/extension dependency; NFD + ASCII whitespace match TS.
create or replace function public.website_guidance_normalize(p_text text)
returns text language sql immutable security invoker set search_path=pg_catalog as $function$
  select btrim(regexp_replace(
    translate(lower(regexp_replace(normalize(coalesce(p_text,''),NFD),U&'[\0300-\036f]','','g') collate "C"),
      chr(9)||chr(10)||chr(11)||chr(12)||chr(13),'     '),
    ' +',' ','g'));
$function$;

create or replace function public.website_question_guidance(p_item jsonb)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $function$
declare v_ref text; v_field text; v_guidance text; v_question text; v_source boolean:=false;
begin
  if p_item is null or jsonb_typeof(p_item)<>'object' or jsonb_typeof(p_item->'coverageRefs') is distinct from 'array' then
    raise exception 'website_guidance_item_invalid';
  end if;
  if left(coalesce(p_item->>'id',''),10)='candidate:' or exists(
    select 1 from jsonb_array_elements_text(p_item->'coverageRefs') ref where left(ref,20)='discovery.candidate.'
  ) then return 'Essa informação veio do website e está sendo corrigida; registraremos sua versão para revisão, sem tratar o texto do site como sua confirmação.'; end if;
  for v_ref in select jsonb_array_elements_text(p_item->'coverageRefs') loop
    v_field:=regexp_replace(v_ref,'^.*:','');
    v_guidance:=case v_field
      when 'area.coverage' then 'Área atendida é a lista exata de cidades; exceções fora dessa lista são uma decisão separada.'
      when 'area.out_of_area_policy' then 'A política fora da área define se um pedido deve ser recusado ou encaminhado para uma exceção aprovada pelo dono.'
      when 'area.travel_fee' then 'Taxa de deslocamento é uma cobrança pelo trajeto, separada do preço do serviço e da permissão para atender fora da área.'
      when 'service.catalog_closure' then 'Já usamos os serviços identificados no website; esta confirmação verifica se a lista está completa e correta.'
      when 'service.name_synonyms' then 'São os nomes e apelidos que os clientes usam para identificar esse mesmo serviço.'
      when 'service.price_mode' then 'Modo de preço indica se o valor é fixo, a partir de, estimado ou depende de análise do dono, preservando suas condições.'
      when 'service.price_target' then 'Preço público é o valor informado ao cliente com suas condições; ele não é o mínimo privado de negociação.'
      when 'service.negotiation' then 'O mínimo de negociação é privado e só se aplica quando você permite negociar, sem alterar automaticamente o preço público.'
      when 'service.duration' then 'Duração é o tempo gasto em um atendimento desse serviço, não o horário de abertura da empresa.'
      when 'service.inclusions_exclusions' then 'Inclusões e exclusões separam o que faz parte do serviço do que fica fora dele ou exige outro orçamento.'
      when 'service.materials_parts' then 'Aqui distinguimos quais materiais e peças estão incluídos, quem os fornece e como tratar peças trazidas pelo cliente.'
      when 'service.warranty' then 'Garantia deste serviço reúne quem a oferece, o que cobre, suas condições e o que fica excluído.'
      when 'service.emergency_eligibility' then 'Essa informação indica se o serviço pode ser tratado como emergência, não se o Ligou pode confirmá-lo sozinho.'
      when 'service.escalation' then 'Encaminhar ao dono significa aguardar sua decisão antes de confirmar a ação que depende de aprovação.'
      when 'schedule.business_hours' then 'Horário comercial define dias, horas e fuso do atendimento normal; duração de serviço e emergências fora desse horário são separados.'
      when 'schedule.same_day_lead_time' then 'Essa regra separa atendimento no mesmo dia da antecedência mínima necessária, sem prometer disponibilidade.'
      when 'schedule.capacity_buffer' then 'Capacidade e intervalo definem quantos atendimentos cabem na agenda e a margem necessária entre eles.'
      when 'schedule.reschedule_cancel' then 'Essa política define como tratar remarcação, cancelamento e ausência, sem presumir autorização para cobrar uma taxa.'
      when 'schedule.holidays' then 'Feriados podem ter uma regra diferente dos dias normais; registramos funcionamento e eventuais restrições.'
      when 'emergency.types' then 'Tipos de emergência são as situações que sua empresa considera urgentes, separadas da autorização para aceitar o atendimento.'
      when 'emergency.safety_escalation' then 'Aqui registramos as instruções de segurança e para quem encaminhar situações de risco, sem inventar orientações.'
      when 'emergency.after_hours' then 'Atendimento fora do horário é separado do expediente normal e precisa de regras próprias de disponibilidade e aprovação.'
      when 'emergency.fee_authority' then 'Uma taxa publicada não dá permissão para confirmá-la ou cobrá-la; aqui registramos quem decide e quais aprovações são necessárias.'
      when 'policy.payment_estimate' then 'Essa política distingue formas de pagamento, depósitos e condições de orçamento da autorização para cobrar.'
      when 'policy.warranty_materials' then 'Garantia e peças do cliente são assuntos diferentes: registramos a cobertura e como tratar materiais fornecidos pelo cliente.'
      when 'policy.access_cancellation' then 'Essa política trata de acesso impossível, visita e cancelamento, mantendo qualquer cobrança sujeita à autorização definida.'
      when 'policy.complaints_returns' then 'Aqui registramos como encaminhar reclamações, retornos ou retrabalho, sem prometer reembolso ou nova visita automaticamente.'
      when 'business.customer_types' then 'Tipos de clientes distinguem atendimento residencial, comercial ou ambos.'
      when 'business.excluded_work' then 'Trabalhos excluídos são serviços que a empresa não realiza e que o Ligou não deve prometer.'
      when 'business.languages_tone' then 'Esta informação define a apresentação, o tom e os idiomas usados no atendimento.'
      when 'authority.quote_price' then 'Informar um preço é comunicá-lo ao cliente; negociar descontos, cobrar e agendar são permissões separadas.'
      when 'authority.negotiate_floor' then 'O mínimo de negociação é privado e só se aplica quando você permite negociar, sem alterar automaticamente o preço público.'
      when 'authority.read_calendar' then 'Consultar a agenda permite apenas ver disponibilidade; não significa autorizar agendamentos ou alterações.'
      when 'authority.book' then 'A pergunta distingue consultar horários de confirmar um compromisso com o cliente, que exige uma permissão própria.'
      when 'authority.reschedule_cancel' then 'Remarcar e cancelar alteram um compromisso existente e precisam de autorização própria, separada da consulta da agenda.'
      when 'authority.charge_fee' then 'Uma taxa publicada não dá permissão para confirmá-la ou cobrá-la; aqui registramos quem decide e quais aprovações são necessárias.'
      when 'authority.emergency' then 'Autonomia em emergências define o que depende da sua aprovação; urgência não concede permissão automaticamente.'
      when 'authority.out_of_area' then 'Essa autorização trata de exceções fora das cidades atendidas e não amplia automaticamente a área de atendimento.'
      else null end;
    if v_guidance is not null then return v_guidance; end if;
    if left(v_field,25)='discovery.owner_question.' then v_source:=true; end if;
  end loop;
  if v_source then
    v_question:=public.website_guidance_normalize(coalesce(p_item->>'questionPt',''));
    if v_question ~ 'fuso horario|timezone' then return 'Fuso horário é a referência de hora local usada para interpretar a agenda e os horários de atendimento.'; end if;
    if v_question ~ 'garant|warrant' then return 'Precisamos separar quem oferece a garantia, o que ela cobre, suas condições e o que fica excluído.'; end if;
    if v_question ~ 'cidades|territorio|limites.*atendimento' then return 'Área atendida é a lista exata de cidades; exceções fora dessa lista são uma decisão separada.'; end if;
    if v_question ~ 'taxa|fee' then return 'Taxa extra é uma cobrança além do valor normal; sua existência e a autorização para confirmá-la ou cobrá-la são informações separadas.'; end if;
    if v_question ~ 'cancel|reagend|remarc|deposit|comparecimento' then return 'Essa política reúne cancelamento, reagendamento, depósito e ausência, sem presumir autorização para aplicar uma cobrança.'; end if;
    if v_question ~ 'feriad|holiday' then return 'Feriados podem ter uma regra diferente dos dias normais; registramos funcionamento e eventuais restrições.'; end if;
    if v_question ~ 'horario|sabado|domingo|mon.sat|saturday' then return 'O website apresenta versões diferentes sobre o funcionamento; registraremos a regra correta informada por você.'; end if;
    if v_question ~ 'contrad|conflit|diverg' then return 'Há versões diferentes dessa informação no website; sua resposta deve esclarecer qual delas vale ou qual é a correção.'; end if;
    if v_question ~ 'preco|price' then return 'Preço público é o valor informado ao cliente com suas condições; ele não é o mínimo privado de negociação.'; end if;
  end if;
  return 'Esta pergunta registra uma informação necessária para o atendimento; sua resposta será guardada para revisão, sem criar autorização automática.';
end;
$function$;

create or replace function public.website_approval_clarification(p_owner_text text)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $function$
declare v_text text:=public.website_guidance_normalize(p_owner_text);
begin
  if v_text ~ 'escreva|redija|propaganda|texto.*(site|script|anuncio)|(manda|mande|crie|cria).*texto|(crie|cria|monte|faca).*(anuncio|campanha|postagem|post para|logo)' then return 'Podemos tratar desse pedido depois; agora precisamos revisar e concluir seu onboarding.'; end if;
  if v_text ~ 'o que significa|pode explicar|poderia explicar|explique|me explica|nao entendi|o que voce quer dizer|como funciona (a |essa |esta )?(aprovacao|confirmacao)|que resumo' then return 'O resumo reúne o que você confirmou e separa o que ficou pendente; diga qual informação precisa corrigir ou confirme se está correto.'; end if;
  return 'Aqui, confirmar é dizer que o resumo está correto; se algo estiver errado, indique a informação que precisa mudar.';
end;
$function$;

revoke all on function public.website_guidance_normalize(text) from public,anon,authenticated,service_role;
revoke all on function public.website_question_guidance(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.website_approval_clarification(text) from public,anon,authenticated,service_role;

create function public.claim_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action jsonb,p_summary uuid default null,p_part integer default null,p_clarification_turn text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_summary public.website_interview_summaries;
  v_kind text:=p_action->>'kind'; v_text text:=p_action->>'text'; v_id text:=p_action->>'actionId'; v_slot text;
  v_expected text; v_opening text; v_opening_id text; v_approved boolean; v_played_at timestamptz; v_current_item jsonb; v_owner_text text; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if p_action is null or jsonb_typeof(p_action)<>'object' or (select count(*) from jsonb_object_keys(p_action))<>7
    or coalesce(v_id ~ '^[a-f0-9]{64}$',false)=false or length(btrim(coalesce(v_text,''))) not between 1 and 4096
    or p_action->>'interviewId' is distinct from v_i.interview_id::text or p_action->>'callId' is distinct from p_call::text
    or p_action->'revision' is distinct from v_i.agenda->'revision' or p_action->>'sourceDigest' is distinct from v_i.digest then raise exception 'interview_speech_binding_invalid'; end if;
  if v_i.state='complete' then raise exception 'interview_complete'; end if;
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=v_id for update;
  if v_s.action_id is not null then
    if v_s.action is distinct from p_action or v_s.summary_id is distinct from p_summary or v_s.part_index is distinct from p_part or v_s.clarification_turn_id is distinct from p_clarification_turn then raise exception 'interview_speech_conflict'; end if;
    return public.website_interview_speech_readback(p_call,v_id,false);
  end if;
  v_approved:=exists(select 1 from public.website_interview_approvals where interview_id=v_i.interview_id);
  if v_kind<>'SPEAK_TERMINAL_ERROR' and exists(select 1 from public.website_interview_speech where call_id=p_call and action->>'kind'='SPEAK_TERMINAL_ERROR') then raise exception 'interview_terminal_speech_latched'; end if;
  if v_approved and v_kind not in ('SPEAK_FINAL_SIGNOFF','SPEAK_TERMINAL_ERROR') then raise exception 'interview_speech_after_approval'; end if;
  if p_summary is not null then
    select * into v_summary from public.website_interview_summaries where id=p_summary and interview_id=v_i.interview_id and call_id=p_call and digest=v_i.digest;
    if v_summary.id is null then raise exception 'interview_summary_changed'; end if;
  end if;
  select 'Oi! Aqui é o Ligou, agente de inteligência artificial da '||t.name||'. Eu já analisei seu website. '||(v_i.next_action->>'spokenPt') into v_opening from public.tenants t where t.id=v_i.tenant_id;
  v_opening_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(v_i.next_action->>'actionId','opening',v_opening)),'sha256'),'hex');
  if v_kind='ASK_NEXT_GAP' and v_text=v_opening and v_id=v_opening_id and not exists(select 1 from public.website_interview_speech where call_id=p_call) then
    v_slot:='opening'; v_expected:=v_opening;
  elsif v_kind='GENERATE_FINAL_SUMMARY' and v_summary.id is not null then
    if p_part is null or p_part<0 or p_part>=jsonb_array_length(v_summary.parts) then raise exception 'interview_summary_part_invalid'; end if;
    if p_part>0 and not exists(select 1 from public.website_interview_speech where summary_id=p_summary and part_index=p_part-1 and status='played') then raise exception 'interview_summary_previous_part_unplayed'; end if;
    v_slot:='summary:'||p_summary::text||':'||p_part::text; v_expected:=v_summary.parts->>p_part;
  elsif v_kind='REQUEST_FINAL_APPROVAL' and v_summary.id is not null then
    if exists(select 1 from generate_series(0,jsonb_array_length(v_summary.parts)-1) n where not exists(select 1 from public.website_interview_speech s where s.summary_id=p_summary and s.part_index=n and s.action->>'kind'='GENERATE_FINAL_SUMMARY' and s.status='played')) then raise exception 'interview_summary_not_fully_played'; end if;
    v_expected:='Está tudo correto no resumo e você confirma essas informações? Se precisar, diga o que devo corrigir.';
    v_slot:='approval:'||p_summary::text;
    if p_clarification_turn is not null then
      select max(played_at) into v_played_at from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL' and status='played';
      if v_played_at is null or (select count(*) from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL')>=2
        or not exists(select 1 from public.website_interview_owner_turns t where t.call_id=p_call and p_call::text||':'||t.provider_item_id=p_clarification_turn and t.created_at>v_played_at) then raise exception 'interview_approval_clarification_invalid'; end if;
      select owner_text into v_owner_text from public.website_interview_owner_turns t where t.call_id=p_call and p_call::text||':'||t.provider_item_id=p_clarification_turn and t.created_at>v_played_at;
      if v_owner_text is null then raise exception 'interview_approval_clarification_invalid'; end if;
      v_expected:=public.website_approval_clarification(v_owner_text)||' '||v_expected;
      v_slot:=v_slot||':'||p_clarification_turn;
    end if;
  elsif v_kind='SPEAK_FINAL_SIGNOFF' then
    if not v_approved then raise exception 'interview_signoff_requires_approval'; end if;
    v_slot:='signoff'; v_expected:='Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.';
  elsif v_kind='SPEAK_TERMINAL_ERROR' then
    v_slot:='terminal-error'; v_expected:=v_text;
  elsif v_kind=v_i.next_action->>'type' and v_kind in ('ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT','DEFER_OFF_SCOPE_AND_CONTINUE','HANDLE_OWNER_CORRECTION') then
    v_slot:='queue:'||(v_i.next_action->>'actionId'); v_expected:=v_i.next_action->>'spokenPt';
    if v_kind='CLARIFY_CURRENT_GAP' then
      select value into v_current_item from jsonb_array_elements(v_i.agenda->'items'||(v_i.agenda->'candidateOverrides')) where value->>'id'=v_i.next_action->>'itemId' and value->>'status' in ('open','awaiting_clarification');
      if v_current_item is null then raise exception 'interview_speech_action_not_current'; end if;
      v_expected:=public.website_question_guidance(v_current_item)||' '||v_expected;
    end if;
  else raise exception 'interview_speech_action_not_current'; end if;
  if v_text is distinct from v_expected then raise exception 'interview_speech_text_mismatch'; end if;
  if exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and speech_slot=v_slot) then raise exception 'interview_speech_alias_conflict'; end if;
  insert into public.website_interview_speech(call_id,action_id,tenant_id,interview_id,digest,action,speech_slot,summary_id,part_index,clarification_turn_id,status)
    values(p_call,v_id,v_i.tenant_id,v_i.interview_id,v_i.digest,p_action,v_slot,p_summary,p_part,p_clarification_turn,'preparing');
  return public.website_interview_speech_readback(p_call,v_id,true);
end $$;

create function public.complete_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_audio bytea; v_receipt uuid:=gen_random_uuid(); begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.action_id is null or v_s.digest<>v_i.digest or v_i.state='complete' then raise exception 'interview_speech_not_current'; end if;
  if p_payload is null or octet_length(p_payload::text)>2200000 or jsonb_typeof(p_payload)<>'object' then raise exception 'interview_speech_payload_invalid'; end if;
  if (p_payload-array['schema','text_sha256','audio_base64','audio_sha256','mime','voice','tts_model','cost_usd']) is distinct from v_s.action
    or p_payload->>'schema' is distinct from 'onboarding.speech.v1' or p_payload->>'mime' is distinct from 'audio/mpeg'
    or p_payload->>'voice' is distinct from 'ash' or p_payload->>'tts_model' is distinct from 'tts-1-hd'
    or p_payload->>'text_sha256' is distinct from encode(extensions.digest(v_s.action->>'text','sha256'),'hex')
    or jsonb_typeof(p_payload->'cost_usd') is distinct from 'number' or length(coalesce(p_payload->>'audio_base64','')) not between 4 and 2000000 then raise exception 'interview_speech_payload_invalid'; end if;
  if (p_payload->>'cost_usd')::numeric<>round(length(v_s.action->>'text')*30::numeric/1000000,8) then raise exception 'interview_speech_cost_invalid'; end if;
  v_audio:=decode(p_payload->>'audio_base64','base64');
  if octet_length(v_audio) not between 4 and 1500000 or replace(encode(v_audio,'base64'),E'\n','') is distinct from p_payload->>'audio_base64'
    or encode(extensions.digest(v_audio,'sha256'),'hex') is distinct from p_payload->>'audio_sha256'
    or not (substring(v_audio from 1 for 3)=decode('494433','hex') or (get_byte(v_audio,0)=255 and (get_byte(v_audio,1)&224)=224 and (get_byte(v_audio,1)&6)<>0 and (get_byte(v_audio,2)&240)<>240 and (get_byte(v_audio,2)&12)<>12)) then raise exception 'interview_speech_audio_invalid'; end if;
  if v_s.status in ('ready','played') then
    if v_s.payload is distinct from p_payload then raise exception 'interview_speech_payload_conflict'; end if;
    return public.website_interview_speech_readback(p_call,p_action);
  end if;
  if v_s.status<>'preparing' then raise exception 'interview_speech_claim_not_preparing'; end if;
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-speech-ready:'||p_call::text||':'||p_action,p_payload->>'audio_sha256',jsonb_build_object('action',v_s.action,'textSha256',p_payload->>'text_sha256','audioSha256',p_payload->>'audio_sha256'),jsonb_build_object('state','ready'));
  update public.website_interview_speech set status='ready',payload=p_payload,ready_receipt_id=v_receipt where call_id=p_call and action_id=p_action;
  return public.website_interview_speech_readback(p_call,p_action);
end $$;

create function public.fail_website_interview_speech(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_receipt uuid:=gen_random_uuid(); begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.action_id is null or v_s.digest<>v_i.digest or v_i.state='complete' then raise exception 'interview_speech_not_current'; end if;
  if v_s.status='failed' then return public.website_interview_speech_readback(p_call,p_action); end if;
  if v_s.status not in ('preparing','ready') or length(btrim(coalesce(p_reason,''))) not between 1 and 512 then raise exception 'interview_speech_failure_invalid'; end if;
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,detail) values(v_receipt,v_i.tenant_id,p_call,'website_interview','failed','website-speech-failed:'||p_call::text||':'||p_action,jsonb_build_object('reason',p_reason,'actionId',p_action));
  update public.website_interview_speech set status='failed',failure_receipt_id=v_receipt where call_id=p_call and action_id=p_action;
  return public.website_interview_speech_readback(p_call,p_action);
end $$;

create function public.record_website_interview_speech_played(p_owner uuid,p_call uuid,p_request uuid,p_action text,p_assistant_item text,p_assistant_text text,p_text_hash text,p_audio_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_speech; v_receipt uuid:=gen_random_uuid(); begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_s from public.website_interview_speech where call_id=p_call and action_id=p_action for update;
  if v_s.action_id is null or v_s.digest<>v_i.digest or v_i.state='complete' then raise exception 'interview_speech_not_current'; end if;
  if p_assistant_item is distinct from 'lgs-'||left(p_action,28) or p_assistant_text is distinct from v_s.action->>'text'
    or p_text_hash is distinct from v_s.payload->>'text_sha256' or p_audio_hash is distinct from v_s.payload->>'audio_sha256' then raise exception 'interview_speech_ack_mismatch'; end if;
  if v_s.status='played' then return jsonb_build_object('receiptId',v_s.played_receipt_id,'actionId',p_action,'replayed',true); end if;
  if v_s.status<>'ready' then raise exception 'interview_speech_not_ready'; end if;
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-speech-played:'||p_call::text||':'||p_action,p_audio_hash,jsonb_build_object('actionId',p_action,'assistantItemId',p_assistant_item,'assistantText',p_assistant_text,'textSha256',p_text_hash,'audioSha256',p_audio_hash),jsonb_build_object('readyReceiptId',v_s.ready_receipt_id));
  update public.website_interview_speech set status='played',played_receipt_id=v_receipt,played_at=clock_timestamp() where call_id=p_call and action_id=p_action;
  return jsonb_build_object('receiptId',v_receipt,'actionId',p_action,'replayed',false);
end $$;

create function public.website_interview_positive_approval(p_text text) returns boolean
language plpgsql immutable set search_path='' as $$ declare v_normal text; begin
  v_normal:=regexp_replace(normalize(lower(p_text),NFD),U&'[\0300-\036F]','','g');
  if v_normal is null or v_normal ~ '[^a-z[:space:].,!;:–—-]' then return false; end if;
  v_normal:=btrim(regexp_replace(v_normal,'[[:space:].,!;:–—-]+',' ','g'));
  return v_normal ~ '^(sim|aprovo|aprovad[oa]|confirmo|esta( tudo)? corret[oa]|tudo (certo|correto)|corret[oa]|pode (salvar|confirmar))( (e )?(sim|aprovo|aprovad[oa]|confirmo|esta( tudo)? corret[oa]|tudo (certo|correto)|corret[oa]|pode (salvar|confirmar)))*$';
end;
$$;

create function public.approve_website_interview_summary(p_owner uuid,p_call uuid,p_request uuid,p_summary uuid,p_summary_hash text,p_item text,p_revision bigint,p_store_version bigint,p_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_s public.website_interview_summaries; v_a public.website_interview_approvals;
  v_turn public.website_interview_owner_turns; v_played_at timestamptz; v_receipt uuid:=gen_random_uuid(); v_readback jsonb; v_draft jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  select * into v_a from public.website_interview_approvals where interview_id=v_i.interview_id;
  if v_a.interview_id is not null then
    if v_a.call_id<>p_call or v_a.summary_id<>p_summary or v_a.provider_item_id<>p_item then raise exception 'interview_approval_conflict'; end if;
    select readback into v_readback from public.receipts where id=v_a.receipt_id;
    if v_readback->>'summaryHash' is distinct from p_summary_hash or v_readback->>'digest' is distinct from p_digest
      or (v_readback->>'revision')::bigint is distinct from p_revision or (v_readback->>'storeVersion')::bigint is distinct from p_store_version+1 then raise exception 'interview_approval_conflict'; end if;
    return v_readback;
  end if;
  if v_i.digest is distinct from p_digest or v_i.db_version is distinct from p_store_version or (v_i.agenda->>'revision')::bigint is distinct from p_revision or v_i.state<>'reviewing' then raise exception 'interview_approval_snapshot_changed'; end if;
  select * into v_s from public.website_interview_summaries where id=p_summary and interview_id=v_i.interview_id and call_id=p_call and digest=p_digest and summary_hash=p_summary_hash and store_version=p_store_version;
  if v_s.id is null then raise exception 'interview_summary_changed'; end if;
  if exists(select 1 from generate_series(0,jsonb_array_length(v_s.parts)-1) n where not exists(select 1 from public.website_interview_speech s where s.summary_id=p_summary and s.part_index=n and s.action->>'kind'='GENERATE_FINAL_SUMMARY' and s.status='played')) then raise exception 'interview_summary_not_fully_played'; end if;
  select max(played_at) into v_played_at from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL' and status='played';
  select * into v_turn from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  if v_played_at is null or v_turn.call_id is null or v_turn.created_at<=v_played_at then raise exception 'interview_approval_turn_not_after_question'; end if;
  if not public.website_interview_positive_approval(v_turn.owner_text) then raise exception 'interview_approval_not_strict_affirmation'; end if;
  v_draft:=jsonb_build_object('schema_version','website_interview.finalized.v1','candidateDraftId',v_s.draft_id,'agenda',v_i.agenda,'summaryId',p_summary,'summaryHash',p_summary_hash,'parts',v_s.parts,
    'factBatchReceiptIds',coalesce((select jsonb_agg(f.agenda_receipt_id order by f.created_at,f.call_id,f.provider_item_id) from public.website_interview_fact_batches f where f.interview_id=v_i.interview_id),'[]'::jsonb),
    'authority',jsonb_build_object('rules_approved',false,'powers_granted',false,'operational_mode_changed',false));
  v_readback:=jsonb_build_object('approvalReceiptId',v_receipt,'receiptId',v_receipt,'turnId',p_call::text||':'||p_item,'summaryId',p_summary,'summaryHash',p_summary_hash,'revision',p_revision,'digest',p_digest,'storeVersion',v_i.db_version+1);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail) values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-approval:'||v_i.interview_id::text,p_summary_hash,v_readback,jsonb_build_object('ownerText',v_turn.owner_text,'ownerTurnId',p_call::text||':'||p_item));
  insert into public.website_interview_approvals(interview_id,tenant_id,call_id,summary_id,provider_item_id,owner_text,receipt_id,finalized_draft) values(v_i.interview_id,v_i.tenant_id,p_call,p_summary,p_item,v_turn.owner_text,v_receipt,v_draft);
  update public.website_interviews set state='closing',db_version=db_version+1,receipt_id=v_receipt where interview_id=v_i.interview_id;
  return v_readback;
end $$;

create function public.record_website_interview_completion(p_owner uuid,p_call uuid,p_request uuid,p_outcome text,p_approval uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_c public.calls; v_b public.budget_reservations; v_a public.website_interview_approvals;
  v_receipt uuid:=gen_random_uuid(); v_existing public.receipts; v_readback jsonb; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request,false);
  if coalesce(p_outcome,'') not in ('complete','unfinished') then raise exception 'interview_completion_outcome_invalid'; end if;
  select * into v_existing from public.receipts where kind='website_interview' and tenant_id=v_i.tenant_id and external_id='website-terminal:'||p_call::text;
  if v_existing.id is not null then
    if v_existing.readback->>'outcome' is distinct from p_outcome or v_existing.readback->>'approvalReceiptId' is distinct from p_approval::text then raise exception 'interview_completion_conflict'; end if;
    return v_existing.readback;
  end if;
  select * into v_c from public.calls where id=p_call for update;
  select * into v_b from public.budget_reservations where call_id=p_call and tenant_id=v_i.tenant_id for update;
  if v_c.ended_at is null or v_c.status not in ('ended','error','killed_budget','killed_deadline') or v_c.provider_termination_state is distinct from 'confirmed' or v_b.status is distinct from 'settled' then raise exception 'interview_terminal_proof_pending'; end if;
  if p_outcome='complete' and (v_c.status is distinct from 'ended' or v_c.provider_termination_reason is distinct from 'agent_ended_session') then raise exception 'interview_completion_requires_owned_finish'; end if;
  select * into v_a from public.website_interview_approvals where interview_id=v_i.interview_id;
  if p_outcome='complete' and (v_a.receipt_id is null or v_a.receipt_id is distinct from p_approval or v_a.call_id<>p_call
    or exists(select 1 from public.website_interview_speech where call_id=p_call and action->>'kind'='SPEAK_TERMINAL_ERROR')
    or not exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and action->>'kind'='SPEAK_FINAL_SIGNOFF' and status='played' and played_at>v_a.created_at)) then raise exception 'interview_completion_signoff_or_approval_missing'; end if;
  v_readback:=jsonb_build_object('receiptId',v_receipt,'interviewId',v_i.interview_id,'callId',p_call,'outcome',p_outcome,'approvalReceiptId',p_approval,'providerConfirmed',true,'callStatus',v_c.status,'budgetReservationId',v_b.id,'budgetSettled',true);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail) values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted','website-terminal:'||p_call::text,encode(extensions.digest(public.onboarding_canonical_json_v1(v_readback),'sha256'),'hex'),v_readback,jsonb_build_object('state',p_outcome));
  update public.website_interview_speech set status='superseded' where call_id=p_call and status in ('preparing','ready');
  if p_outcome='complete' then update public.website_interviews set state='complete',db_version=db_version+1,receipt_id=v_receipt where interview_id=v_i.interview_id; end if;
  return v_readback;
end $$;

-- Authenticated clients never receive historical, superseded, or already-played
-- audio to replay. Scope is derived from auth.uid and the current call binding.
create function public.read_website_interview_speech(p_call uuid,p_action text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_s public.website_interview_speech; begin
  select s.* into v_s from public.website_interview_speech s join public.website_interviews i on i.interview_id=s.interview_id
    join public.tenants t on t.id=i.tenant_id join public.calls c on c.id=s.call_id
    join public.website_interview_calls wc on wc.call_id=c.id join public.browser_session_requests br on br.id=wc.request_id
    where s.call_id=p_call and s.action_id=p_action and i.current_call_id=p_call and i.digest=s.digest and i.state<>'complete'
      and t.owner_user_id=auth.uid() and br.user_id=auth.uid() and c.status='active' and c.ended_at is null
      and c.test_memory_generation=t.test_memory_generation and br.test_memory_generation=t.test_memory_generation;
  if v_s.action_id is null then raise exception using errcode='42501',message='interview_speech_not_owner_bound'; end if;
  if v_s.status<>'ready' then return null; end if;
  return v_s.payload;
end $$;

create function public.list_website_interview_terminal_candidates(p_limit integer default 4) returns jsonb
language plpgsql security definer set search_path='' as $$ declare v_result jsonb; begin
  perform public.website_interview_service_guard();
  if p_limit is null or p_limit not between 1 and 8 then raise exception 'interview_terminal_candidate_limit_invalid'; end if;
  select coalesce(jsonb_agg(candidate),'[]'::jsonb) into v_result from (
    select jsonb_build_object('ownerId',i.owner_id,'requestId',wc.request_id,'interviewId',i.interview_id,'callId',c.id,'tenantId',i.tenant_id,'state',i.state,
      'callStatus',c.status,'providerTerminationReason',c.provider_termination_reason,'approvalReceiptId',a.receipt_id,
      'canComplete',i.state='closing' and a.receipt_id is not null and c.status='ended' and c.provider_termination_reason='agent_ended_session'
        and exists(select 1 from public.website_interview_speech s where s.call_id=c.id and s.digest=i.digest and s.action->>'kind'='SPEAK_FINAL_SIGNOFF' and s.status='played' and s.played_at>a.created_at)
        and not exists(select 1 from public.website_interview_speech s where s.call_id=c.id and s.action->>'kind'='SPEAK_TERMINAL_ERROR')) as candidate
    from public.website_interviews i join public.website_interview_calls wc on wc.call_id=i.current_call_id and wc.interview_id=i.interview_id
    join public.calls c on c.id=wc.call_id and c.tenant_id=i.tenant_id join public.tenants t on t.id=i.tenant_id and t.owner_user_id=i.owner_id
    join public.budget_reservations b on b.call_id=c.id and b.tenant_id=i.tenant_id
    left join public.website_interview_approvals a on a.interview_id=i.interview_id and a.call_id=c.id
    where i.state in ('unfinished','reviewing','closing') and c.status in ('ended','error','killed_budget','killed_deadline') and c.ended_at is not null
      and c.provider_termination_state='confirmed' and b.status='settled' and c.test_memory_generation=t.test_memory_generation and i.generation=t.test_memory_generation
      and not exists(select 1 from public.receipts r where r.tenant_id=i.tenant_id and r.kind='website_interview' and r.external_id='website-terminal:'||c.id::text)
    order by c.ended_at,c.id limit p_limit
  ) q;
  return v_result;
end $$;

create function public.get_website_interview_status(p_call uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_approval uuid; v_terminal jsonb; v_parts jsonb; v_call public.calls; v_budget public.budget_reservations; begin
  select i.* into v_i from public.website_interviews i join public.website_interview_calls wc on wc.interview_id=i.interview_id
    join public.tenants t on t.id=i.tenant_id join public.calls c on c.id=wc.call_id
    where wc.call_id=p_call and t.owner_user_id=auth.uid() and c.test_memory_generation=t.test_memory_generation;
  if v_i.interview_id is null then raise exception using errcode='42501',message='interview_not_owner_bound'; end if;
  select receipt_id into v_approval from public.website_interview_approvals where interview_id=v_i.interview_id;
  select readback into v_terminal from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview' and external_id='website-terminal:'||p_call::text;
  select parts into v_parts from public.website_interview_summaries where interview_id=v_i.interview_id and digest=v_i.digest order by created_at desc limit 1;
  select * into v_call from public.calls where id=p_call;
  select * into v_budget from public.budget_reservations where call_id=p_call and tenant_id=v_i.tenant_id;
  return jsonb_build_object('interviewId',v_i.interview_id,'callId',p_call,'currentCallId',v_i.current_call_id,'state',v_i.state,'revision',(v_i.agenda->>'revision')::bigint,'storeVersion',v_i.db_version,'digest',v_i.digest,'summaryParts',v_parts,'approvalReceiptId',v_approval,'terminal',v_terminal,
    'callStatus',v_call.status,'providerTerminationState',v_call.provider_termination_state,'budgetStatus',v_budget.status,
    'completed',coalesce(v_i.state='complete' and v_terminal->>'outcome'='complete',false));
end $$;

-- Add optional staging atomically around the existing reducer persistence RPC.
-- A staged fact has exact owner provenance but is NOT an approved rule.
create function public.commit_website_interview_turn(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_agenda jsonb,p_proposal_kind text,p_facts jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_receipt public.receipts; v_i public.website_interviews; v_text text; v_existing jsonb; v_refs jsonb; begin
  if p_facts is null or jsonb_typeof(p_facts)<>'array' or octet_length(p_facts::text)>131072 then raise exception 'interview_facts_invalid'; end if;
  if jsonb_array_length(p_facts)>100 or exists(select 1 from jsonb_array_elements(p_facts) x where jsonb_typeof(x)<>'object' or length(btrim(coalesce(x->>'field','')))=0 or coalesce(x->>'disposition','') not in ('answered','not_applicable','owner_review_required') or jsonb_typeof(x->'structured') is distinct from 'object') then raise exception 'interview_facts_invalid'; end if;
  v_result:=public.commit_website_interview_turn(p_owner,p_call,p_request,p_revision,p_store_version,p_digest,p_item,p_agenda,p_proposal_kind);
  select * into v_i from public.website_interviews where interview_id=(v_result->'agenda'->'binding'->>'interviewId')::uuid;
  select * into v_receipt from public.receipts where tenant_id=v_i.tenant_id and kind='website_interview' and external_id='website-interview:'||p_call::text||':turn:'||p_item;
  select owner_text into v_text from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  select coalesce(jsonb_agg(distinct ref),'[]'::jsonb) into v_refs from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) item,
    jsonb_array_elements(item->'coverageRefs') ref where item->'evidence' @> jsonb_build_array(jsonb_build_object('turnId',p_call::text||':'||p_item,'text',v_text));
  if jsonb_array_length(p_facts)>0 and (p_proposal_kind not in ('answer','correction','not_applicable') or exists(
    select 1 from jsonb_array_elements(p_facts) fact where (fact ? 'owner_words' and fact->>'owner_words' is distinct from v_text)
      or not exists(select 1 from jsonb_array_elements_text(v_refs) ref where ref=fact->>'field' or right(ref,length(fact->>'field')+1)=':'||(fact->>'field')))) then raise exception 'interview_fact_evidence_scope_invalid'; end if;
  select facts into v_existing from public.website_interview_fact_batches where call_id=p_call and provider_item_id=p_item;
  if v_existing is not null and v_existing is distinct from p_facts then raise exception 'interview_facts_replay_conflict'; end if;
  if v_existing is null then insert into public.website_interview_fact_batches(call_id,provider_item_id,tenant_id,interview_id,agenda_receipt_id,owner_text,coverage_refs,facts) values(p_call,p_item,v_i.tenant_id,v_i.interview_id,v_receipt.id,v_text,v_refs,p_facts); end if;
  return v_result;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure signature,p.proname,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
    'website_interview_current','website_interview_evidence_guard','website_interview_speech_readback','website_interview_positive_approval','prepare_website_interview_summary','claim_website_interview_speech','complete_website_interview_speech','fail_website_interview_speech','record_website_interview_speech_played','approve_website_interview_summary','record_website_interview_completion','read_website_interview_speech','get_website_interview_status','list_website_interview_terminal_candidates','commit_website_interview_turn') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('read_website_interview_speech','get_website_interview_status') then execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname not like 'website_interview_%' and not (f.proname='commit_website_interview_turn' and f.pronargs=9) then execute format('grant execute on function %s to service_role',f.signature); end if;
  end loop;
end $$;
commit;
