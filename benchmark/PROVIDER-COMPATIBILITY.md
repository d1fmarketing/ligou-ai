# Voice provider compatibility

Evidence date: **2026-08-21**

This is an official-source qualification, not a provider benchmark result. No
provider API was called, no credential was read, and no voice quality or
business correctness result is claimed. The machine-readable source of truth is
[`config/candidates.json`](config/candidates.json).

## Qualification method

A candidate is the exact combination of provider, model/version, voice,
transport, interruption configuration, and tool configuration. A provider name
by itself is not a candidate.

`QUALIFIED` means current provider-owned API documentation establishes all ten
entry predicates and no unresolved documentation gap prevents an exact,
reconcilable run. `CONDITIONALLY_QUALIFIED` means the configuration is promising
but a stated evidence or reproducibility condition must be closed before Stage
1. `INCOMPATIBLE` means current official documentation establishes a conflicting
capability. `NOT_VERIFIABLE` means the needed official evidence could not be
found. Marketing language was not treated as API evidence.

The ten required predicates are:

1. bidirectional streaming audio;
2. caller interruption;
3. programmatic session termination;
4. deterministic tool-call events;
5. Ligou-owned authority over state-changing tools;
6. transcript or equivalent evidence;
7. usage/cost evidence;
8. automated execution;
9. identifiable model/version;
10. no need to give Google, Supabase, AWS, or tenant credentials to the voice
   model.

## Decision summary

| Candidate | Verdict | Selected for v1 | Decisive reason |
| --- | --- | --- | --- |
| OpenAI `gpt-realtime-2.1` / `marin` | `QUALIFIED` | Yes | The Realtime protocol documents audio, interruption, custom-function events, transcripts, response usage, and programmable teardown; the exact model identifier is listed under Snapshots. [Model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) [Conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) [Costs](https://developers.openai.com/api/docs/guides/realtime-costs) |
| Deepgram Agent v1 / Flux + `gpt-5.4-mini` + `flux-kit-en` | `QUALIFIED` | Yes | The Agent protocol documents client-owned functions and transcripts, while `request_id` joins the session to Management API usage, resolved model UUIDs, and USD cost. [Protocol](https://developers.deepgram.com/reference/voice-agent/voice-agent) [Observability](https://developers.deepgram.com/docs/voice-agent-observability) [Per-request cost](https://developers.deepgram.com/reference/manage/requests/get) |
| Google `gemini-3.1-flash-live-preview` / `Kore` | `CONDITIONALLY_QUALIFIED` | No | All ten entry predicates are documented, but the only current 3.1 Live model is Preview and no immutable dated snapshot is exposed. [Model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) [Live reference](https://ai.google.dev/api/live) |
| xAI `grok-voice-think-fast-2.0` / `eve` | `CONDITIONALLY_QUALIFIED` | No | The Voice reference does not document per-session usage or charged-cost output; the public rate is only “starting at.” [Voice reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) [Voice pricing](https://docs.x.ai/developers/models/speech-to-speech) [General cost tracking](https://docs.x.ai/developers/cost-tracking) |
| ElevenLabs Agents / Gemini 2.5 Flash + Flash v2.5 / Rachel ID | `CONDITIONALLY_QUALIFIED` | No | Post-call agent version and cost are available, but the runtime handshake selects mutable `agent_id`; no official immutable version selector was found for pre-run binding. [WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) [Conversation details](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get) |

Only the two `QUALIFIED` records set `selected_for_v1: true`. That selection is
registry state only; it does not authorize a provider call.

## OpenAI — selected

Exact identity:

- model `gpt-realtime-2.1`, voice `marin`, API `v1`, direct WebSocket
  `/v1/realtime`;
- server VAD with `interrupt_response=true` and explicit threshold/padding/
  silence values;
- custom functions executed by Ligou, returned as
  `function_call_output`.

| Field | Evidence-backed finding | Official source |
| --- | --- | --- |
| Model and pinning | `gpt-realtime-2.1` is the exact model used by the current Realtime guide and is listed in the model page's Snapshots section. The catalog shows no separate dated suffix on the evidence date. | [Model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) |
| Voice | `marin` is a current built-in voice and is one of the two voices recommended for best quality. | [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Transport and bidirectional audio | The server-side WebSocket uses `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`; clients send and receive JSON events and base64 audio. | [WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket) [Conversation audio flow](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Interruption | Server VAD supports `interrupt_response`; manual flows can issue `response.cancel` and truncate unplayed audio. | [VAD](https://developers.openai.com/api/docs/guides/realtime-vad) [Conversation control](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Tools and authority | Function arguments are finalized in deterministic response events. Ligou executes its custom code, then sends a matching `function_call_output`; state-changing credentials never enter model context. | [Function-call flow](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Transcript evidence | Output transcript delta/done events and optional input transcription completion events are part of the documented lifecycle. | [Audio lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Usage and cost evidence | `response.done.response.usage` reports modality-specific input, cached, and output tokens. The model page supplies the rates needed for deterministic cost calculation; it does not return a direct USD cost field. | [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs) [Model pricing](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) |
| Termination | Direct WebSocket sessions are closed by the client. Call-backed sessions expose `POST /v1/realtime/calls/{call_id}/hangup`, documented for SIP and WebRTC teardown. | [WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket) [SIP hangup](https://developers.openai.com/api/docs/guides/realtime-sip) |
| Session duration | Realtime sessions have a 60-minute maximum. | [Session lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Audio formats | The selected path uses 24 kHz PCM in/out. The guide also documents PCMU output for telephony. | [Session audio configuration](https://developers.openai.com/api/docs/guides/realtime-conversations) |
| Rate limits | Tier 1 is 200 RPM, 1,000 RPD, and 40,000 TPM; higher tiers are listed on the model page. | [Model rate limits](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) |
| Region | API access is limited to OpenAI's supported countries and territories. | [Supported countries](https://developers.openai.com/api/docs/supported-countries) |
| Pricing snapshot | Per 1M tokens: text input $4, cached text input $0.40, text output $24; audio input $32, cached audio input $0.40, audio output $64. Input transcription is billed separately. | [Model pricing](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) [Transcription cost rule](https://developers.openai.com/api/docs/guides/realtime-costs) |
| Credential names | `OPENAI_API_KEY` only. | [Server WebSocket authentication](https://developers.openai.com/api/docs/guides/realtime-websocket) |

Verdict: `QUALIFIED`. Direct cost telemetry is absent, so every accepted paid
result must persist `response.done` usage and calculate cost from the frozen rate
card. Missing usage invalidates the result.

## Deepgram — selected

Exact identity:

- listen `flux-general-en` (`v2`), think `gpt-5.4-mini`, speak/voice
  `flux-kit-en` (`v2`), Agent API `v1`;
- binary 16 kHz Linear16 input and 24 kHz Linear16 output over the Agent
  WebSocket;
- `UserStartedSpeaking` barge-in and only `client_side=true` functions.

| Field | Evidence-backed finding | Official source |
| --- | --- | --- |
| Models and pinning | Voice Agent settings accept explicit listen/think/speak model codes, including managed `gpt-5.4-mini`. The per-request record returns resolved model UUIDs, but no immutable pre-run snapshot selector is documented. | [LLM models](https://developers.deepgram.com/docs/voice-agent-llm-models) [TTS models](https://developers.deepgram.com/docs/voice-agent-tts-models) [Request record](https://developers.deepgram.com/reference/manage/requests/get) |
| Transport and bidirectional audio | One Agent WebSocket carries binary input/output audio and JSON configuration/events. | [Build guide](https://developers.deepgram.com/docs/build-a-voice-agent) [Protocol reference](https://developers.deepgram.com/reference/voice-agent/voice-agent) |
| Interruption | On caller speech, Deepgram stops its agent turn and emits `UserStartedSpeaking`; the client immediately clears queued playback. | [Message flow](https://developers.deepgram.com/docs/voice-agent-message-flow) |
| Tools and authority | `FunctionCallRequest`/`FunctionCallResponse` carry IDs and serialized arguments/results. `client_side=true` keeps execution and credentials in Ligou. | [Function calling](https://developers.deepgram.com/docs/voice-agents-function-calling) [Function response](https://developers.deepgram.com/docs/voice-agent-function-call-response) |
| Transcript evidence | `ConversationText` provides user/assistant turns; `History` preserves turns and function-call records when history is enabled. | [Observability](https://developers.deepgram.com/docs/voice-agent-observability) |
| Usage and cost evidence | `Welcome.request_id` is the correlation key. The authenticated Management API returns the exact request's duration, resolved model UUIDs, and `usd` cost. | [Welcome](https://developers.deepgram.com/docs/voice-agent-welcome-message) [Logs and usage](https://developers.deepgram.com/docs/using-logs-usage) [Get request](https://developers.deepgram.com/reference/manage/requests/get) |
| Termination | Ligou closes the owned Agent WebSocket and keeps `request_id` for post-close reconciliation. | [Agent protocol](https://developers.deepgram.com/reference/voice-agent/voice-agent) [Observability](https://developers.deepgram.com/docs/voice-agent-observability) |
| Session duration | Sessions close after two hours, with a warning five minutes before forced termination. | [Feature overview](https://developers.deepgram.com/docs/voice-agent-feature-overview) |
| Audio formats | The exact candidate uses Linear16 input at 16 kHz and Linear16 output at 24 kHz with no container. | [Configuration reference](https://developers.deepgram.com/docs/configure-voice-agent) |
| Rate limits | Voice Agent WSS concurrency is up to 45 on Pay As You Go and 60 on Growth. | [Pricing and concurrency](https://deepgram.com/pricing) |
| Region | The global Agent endpoint is joined by documented EU and AU endpoints; the chosen endpoint becomes run identity. | [Regional endpoints](https://developers.deepgram.com/docs/build-a-voice-agent) |
| Pricing snapshot | Pay As You Go Standard is $0.056/min through 2026-09-12, then $0.075/min. The published rates opt into the Model Improvement Program, and Flux TTS is promotional through that date. | [Voice Agent pricing](https://deepgram.com/pricing) |
| Credential names | `DEEPGRAM_API_KEY` and `DEEPGRAM_PROJECT_ID`. | [Protocol authentication](https://developers.deepgram.com/reference/voice-agent/voice-agent) [Management request endpoint](https://developers.deepgram.com/reference/manage/requests/get) |

Verdict: `QUALIFIED`. The paid adapter must reject a run until the Management
record for the same `request_id` reaches a final state and supplies provider USD
cost. Resolved model UUIDs are mandatory run identity because the configuration
names are not documented as immutable snapshots.

## Google — conditional

Exact identity:

- `gemini-3.1-flash-live-preview`, voice `Kore`, `v1beta`
  `BidiGenerateContent` WebSocket;
- automatic activity detection with high start/end sensitivity and
  `START_OF_ACTIVITY_INTERRUPTS`;
- synchronous function calls executed by Ligou.

| Field | Evidence-backed finding | Official source |
| --- | --- | --- |
| Model and pinning | The model page exposes the exact Preview code but no immutable dated version. It was last updated 2026-08-18. | [Model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) |
| Voice | Native-audio models accept TTS voices; the Live guide uses `Kore` in the session configuration. | [Voice configuration](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |
| Transport and audio | Live uses a bidirectional WebSocket. Audio is raw little-endian 16-bit PCM; native input is 16 kHz and output is 24 kHz. | [Live API reference](https://ai.google.dev/api/live) [Audio formats](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |
| Interruption | `START_OF_ACTIVITY_INTERRUPTS` is the default, cuts off current generation, and produces interrupted/canceled-call evidence. | [Activity handling](https://ai.google.dev/api/live) [VAD behavior](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |
| Tools and authority | `toolCall.functionCalls` asks the client to execute calls; `toolResponse.functionResponses` returns ID-matched results. Gemini 3.1 Live supports synchronous calls. | [Live tool messages](https://ai.google.dev/api/live) [Model limitations](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) |
| Transcript evidence | Opt-in input and output audio transcription messages are documented. | [Live reference](https://ai.google.dev/api/live) [Transcription examples](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |
| Usage and cost evidence | Server messages may contain modality-aware `usageMetadata`; the rate card makes cost derivable. Context is re-billed on each turn and transcriptions add output-text charges. No direct USD field is documented. | [Usage metadata](https://ai.google.dev/api/live) [Pricing](https://ai.google.dev/gemini-api/docs/pricing) [Billing behavior](https://ai.google.dev/gemini-api/docs/live-api/best-practices) |
| Termination and duration | `session.close()` is programmable. Without compression, audio-only sessions are 15 minutes; a connection is around 10 minutes, with session resumption available. | [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) |
| Rate limits | Limits are model/project/tier-specific in AI Studio, are not guaranteed, and Preview models are more restricted. Tier 1's spend cap is $10 per rolling ten minutes. | [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) |
| Region | Use is restricted to Google's published available regions; the United States and Brazil are listed. | [Available regions](https://ai.google.dev/gemini-api/docs/available-regions) |
| Pricing snapshot | Paid tier per 1M tokens: text input $0.75, audio input $3 ($0.005/min equivalent), text output $4.50, audio output $12 ($0.018/min equivalent). | [Pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Credential names | `GEMINI_API_KEY` only. | [Live connection](https://ai.google.dev/gemini-api/docs/live-api/capabilities) |

Verdict: `CONDITIONALLY_QUALIFIED`. The protocol clears all ten entry gates,
but the Preview-only, unpinned model cannot yet satisfy the benchmark's desired
immutable pre-run identity. A later official immutable version could promote the
candidate; popularity or good marketing is not a substitute.

## xAI — conditional

Exact identity:

- `grok-voice-think-fast-2.0`, voice `eve`, API `v1`, direct WebSocket;
- server VAD with the documented default threshold/prefix values;
- only custom functions executed by Ligou.

| Field | Evidence-backed finding | Official source |
| --- | --- | --- |
| Model and pinning | xAI explicitly says to pin the versioned `grok-voice-think-fast-2.0` name instead of `grok-voice-latest`. | [Model selection](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) |
| Transport and audio | Speech to Speech streams audio/text bidirectionally over WebSocket. PCM, PCMU, PCMA, and Opus are documented; this candidate uses 24 kHz PCM. | [Speech to Speech guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) [Voice reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) |
| Interruption | `server_vad` is recommended for natural barge-in; `response.cancel` is available for manual cancellation. | [Barge-in guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) [Client events](https://docs.x.ai/developers/rest-api-reference/inference/voice) |
| Tools and authority | `response.function_call_arguments.done` carries complete arguments and call ID. The developer executes custom functions and returns `function_call_output`. | [Custom function flow](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) [Event reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) |
| Transcript evidence | Input transcription completion/update and output transcript delta/done events are in the Voice reference. | [Voice reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) |
| Usage and cost gap | The Voice `response.done` reference documents completion but no usage/cost object. xAI's general cost-tracking page enumerates chat, Responses, image, and video surfaces, not Speech to Speech. Voice pricing is only “starting at.” | [Voice reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) [Cost tracking](https://docs.x.ai/developers/cost-tracking) [Voice pricing](https://docs.x.ai/developers/models/speech-to-speech) |
| Termination | The client can close the WebSocket; SIP calls additionally expose `POST /v1/realtime/calls/{call_id}/hangup`. | [Voice reference](https://docs.x.ai/developers/rest-api-reference/inference/voice) [SIP call control](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip) |
| Duration, limits, region | Maximum session duration is 120 minutes, concurrency is 10 per team, and the listed cluster is `us-east-1`. | [Speech to Speech model page](https://docs.x.ai/developers/models/speech-to-speech) |
| Pricing snapshot | Audio sent or received starts at $0.05/min; text input is $0.004 per billable `conversation.item.create`. | [Voice pricing](https://docs.x.ai/developers/models/speech-to-speech) |
| Credential names | `XAI_API_KEY` only. | [Authentication](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) |

Verdict: `CONDITIONALLY_QUALIFIED`. The missing predicate is provider-reconciled
usage/cost evidence. Local byte counts multiplied by a “starting at” price would
be an estimate, not a scored provider cost, so this candidate is not selected.

## ElevenLabs — conditional

Exact identity:

- native `gemini-2.5-flash` LLM with backup LLMs disabled;
- `eleven_flash_v2_5` TTS and voice ID `21m00Tcm4TlvDq8ikWAM`;
- `v1` Agent WebSocket with PCM 16 kHz in/out;
- interruption events enabled and only client tools allowed.

| Field | Evidence-backed finding | Official source |
| --- | --- | --- |
| Models | ElevenAgents supports Gemini 2.5 Flash; Flash v2.5 has model ID `eleven_flash_v2_5`. Backup LLMs can be disabled. | [Agent LLMs](https://elevenlabs.io/docs/eleven-agents/customization/llm) [TTS model IDs](https://elevenlabs.io/docs/help-center/technical/how-do-i-find-the-model-id) |
| Pinning gap | Agent configurations are versioned and post-call details return `version_id`, but the connection handshake takes `agent_id`; the consulted official WebSocket reference exposes no immutable version selector. | [WebSocket handshake](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) [Conversation details](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get) |
| Transport and audio | The WebSocket accepts base64 user audio and emits audio plus JSON events. The exact candidate fixes the initiation metadata to `pcm_16000` in/out. | [Agent WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) |
| Interruption | The receive schema includes an Interruption event, and client events must be enabled in agent configuration. | [WebSocket events](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) [Client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events) |
| Tools and authority | `client_tool_call` supplies a tool call ID and parameters; Ligou executes it and sends `client_tool_result`. Provider/server tools are excluded. | [Client tool events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events) |
| Transcript evidence | Live `user_transcript`/`agent_response` events are supplemented by a post-call transcript. | [WebSocket events](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) [Conversation details](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get) |
| Usage and cost evidence | Post-call metadata exposes duration, platform cost, `cost_fiat`, and LLM charging fields. | [Conversation details](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get) |
| Termination and duration | `endSession()` ends the conversation and disconnects. This exact config sets `max_duration_seconds=600`; the reference does not establish that as a provider-wide maximum. | [JavaScript SDK](https://elevenlabs.io/docs/eleven-agents/libraries/java-script) [Agent config](https://elevenlabs.io/docs/eleven-agents/api-reference/agents/get) |
| Rate limits and region | Plans list 4–40 concurrent calls, with optional burst pricing. Hosted models run in the US or an enterprise region; EU residency removes some older LLMs. | [Agents pricing](https://elevenlabs.io/pricing/agents) [Model residency](https://elevenlabs.io/docs/eleven-agents/customization/llm) |
| Pricing snapshot | Additional call minutes are $0.08, burst minutes $0.16, and text messages $0.003. The calculator shows Gemini 2.5 Flash at an estimated $0.0012/min; telephony is separate. | [Agents pricing](https://elevenlabs.io/pricing/agents) |
| Credential names | `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. | [Agent WebSocket](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket) |

Verdict: `CONDITIONALLY_QUALIFIED`. The API clears the ten capability gates,
but a mutable `agent_id` cannot yet be bound to a pre-run immutable version from
the official surface consulted. A paid-plan preflight must close that binding
gap before selection.

## Consequences for later tasks

- Adapter work is limited to records with `selected_for_v1: true`.
- A later official-source refresh may promote or remove a candidate, but it must
  update the exact configuration, evidence date, registry tests, and paid plan
  together.
- Pricing is a dated planning snapshot. A paid result is valid only when the
  provider's usage/cost evidence for that exact session is present.
- No result here is evidence of voice quality, Brazilian-accented English
  performance, tool correctness, or production fitness.
