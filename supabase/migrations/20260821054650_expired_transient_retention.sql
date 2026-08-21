create or replace function public.purge_ephemeral_call_data(
  p_transcript_before timestamptz,
  p_transient_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_transcripts integer := 0;
  v_browser_rows integer := 0;
  v_phone_rows integer := 0;
  v_oauth_states integer := 0;
  v_slot_offers integer := 0;
  v_booking_quotes integer := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_transcript_before is null or p_transient_before is null
    or p_transcript_before > v_now or p_transient_before > v_now then
    raise exception using errcode = '22023', message = 'retention_cutoff_invalid';
  end if;

  update public.calls c
  set transcript = '[]'::jsonb,
      transcript_deleted_at = v_now
  where c.ended_at is not null
    and c.ended_at < p_transcript_before
    and c.transcript <> '[]'::jsonb
    and c.summary_status in ('ready', 'failed')
    and c.learning_status in ('done', 'skipped', 'failed');
  get diagnostics v_transcripts = row_count;

  delete from public.browser_session_requests b
  where b.created_at < p_transient_before
    and b.status in ('ready', 'error', 'expired');
  get diagnostics v_browser_rows = row_count;

  delete from public.phone_events p
  where p.created_at < p_transient_before
    and p.handled_at is not null
    and p.status in ('accepted', 'rejected', 'error');
  get diagnostics v_phone_rows = row_count;

  delete from public.oauth_states o
  where o.expires_at < p_transient_before;
  get diagnostics v_oauth_states = row_count;

  delete from public.slot_offers s
  where s.expires_at < p_transient_before;
  get diagnostics v_slot_offers = row_count;

  delete from public.booking_quotes q
  where q.expires_at < p_transient_before
    and not exists (select 1 from public.slot_offers s where s.quote_id = q.id);
  get diagnostics v_booking_quotes = row_count;

  return jsonb_build_object(
    'transcripts_redacted', v_transcripts,
    'browser_rows_deleted', v_browser_rows,
    'phone_rows_deleted', v_phone_rows,
    'oauth_states_deleted', v_oauth_states,
    'slot_offers_deleted', v_slot_offers,
    'booking_quotes_deleted', v_booking_quotes,
    'completed_at', v_now
  );
end;
$$;

revoke all on function public.purge_ephemeral_call_data(timestamptz,timestamptz)
from public, anon, authenticated;
grant execute on function public.purge_ephemeral_call_data(timestamptz,timestamptz) to service_role;
