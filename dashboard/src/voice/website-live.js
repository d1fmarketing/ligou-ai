// Browser visibility for Live. The server owns business state and Responses tools.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateWebsiteLive(value, callId) {
  const keys = ['callId', 'interviewId', 'revision', 'sourceDigest', 'sessionId'];
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.callId !== callId || !UUID.test(value.callId) || !UUID.test(value.interviewId)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !/^[0-9a-f]{64}$/.test(value.sourceDigest ?? '')
    || typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 512) {
    throw new Error('live_opening_contract_invalid');
  }
  return value;
}

export function liveTranscriptCaption(event) {
  if (!['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event?.type)
    || typeof event.delta !== 'string' || !event.delta || typeof event.event_id !== 'string' || !event.event_id
    || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms < 0 || event.end_ms < event.start_ms) return null;
  return { kind: event.type === 'session.input_transcript.delta' ? 'caller' : 'agent', text: event.delta,
    eventId: event.event_id, startMs: event.start_ms, endMs: event.end_ms, fragment: true };
}

// Caption groups are display-only. Preserve every fragment and its original
// interval; a new caption row never commits an answer or cancels a delegation.
export function appendVoiceCaption(lines, event) {
  if (!event.fragment) return [...lines.slice(-30), event];
  if (lines.some(line => line.fragments?.some(fragment => fragment.eventId === event.eventId))) return lines;
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === event.kind && line.fragments && event.startMs <= line.endMs && event.endMs >= line.startMs) { index = i; break; }
  }
  if (index === -1 && lines.at(-1)?.kind === event.kind && lines.at(-1)?.fragments) index = lines.length - 1;
  if (index === -1) return [...lines.slice(-30), { ...event, id: event.eventId, fragments: [event] }];
  const next = [...lines], previous = next[index];
  // Preserve provider delivery order, including whitespace and repetitions.
  const fragments = [...previous.fragments, event];
  next[index] = { ...previous, text: fragments.map(fragment => fragment.text).join(''), fragments,
    startMs: Math.min(previous.startMs, event.startMs), endMs: Math.max(previous.endMs, event.endMs) };
  return next;
}
