# Active direction: managed OpenAI default — September 10

The user-supplied managed migration goal now replaces the earlier client-delegation/subscription and optional-QA-pilot constraints below. See IMPLEMENTATION-GOAL.md. Responses delegation is the default conversational backend; Agents API must replace real structured analysis from existing collected snapshots. Paid voice/reasoning/agent APIs are authorized within current spending limits; no new credentials/subscriptions/account limits. The aborted cost/retention questions are not approval of their proposed values. Real Agents task allowance and provider-state deletion parameters remain pending; independent implementation continues.

Current candidate: `/Users/d1f/.codex/worktrees/ligou-live1-candidate/Ligou.AI`, branch `codex/ligou-live1-candidate`, committed baseline `f1b02c2` plus coordinated managed migration changes. The Codex adapter/tests/dependency and client context preparer have been removed from the candidate. Live protocol 6 / `live_managed_v1` now connects the browser request to the managed runtime in `server.ts`.

Implemented locally: native Live creation and sideband; managed Responses tool/result/continuation; owner-scoped catalogue, explicit target decisions/corrections/deferral; real fragment provenance and operation receipt reconciliation; early Stop; separate voice/Responses usage and model-aware existing reconciliation. The Live migration is not applied to production. Isolated PostgreSQL verifies target preservation, replay/conflict, wrong-owner/session rejection, more than 512 evidence references, actual role privileges and provider termination independently from usage/approval. Same-offset fragments retain application-observed order instead of sorting opaque provider IDs.

Current diagnostic limitation: the four tools are get_context/save_decision/get_operation/end_call. Final review, explicit approval and normal successful onboarding completion remain C work. No Live candidate deployment or paid voice/Responses/Agents call has run yet. Complete release checks and one real smoke before offering A.

Agents managed workflow, provider lifecycle, output validation and source-preserving SQL tests are implemented. Authenticated entrypoints and consumer selection isolation are being integrated. No real provider task or automatic provider-state deletion has run.

| Current component | Responsibility | Official replacement | Action and retirement condition |
| --- | --- | --- | --- |
| Candidate Codex stdio/auth/delegate adapter | Local text reasoning loop | Live Responses delegation | Remove from candidate now; never shipped to production. |
| Candidate client delegation context builder | Build model input/history | Managed Live conversation context | Remove builder; keep only business evidence/consent references. |
| Realtime-native voice runtime | Voice conversation + local tool flow | GPT-Live-1 with Responses | Replace normal migrated entry after real browser smoke; preserve immutable rollback release. |
| DirectModel/OpenClaw analysis executor | Extract structured onboarding facts from collected pages | Agents API, one agent, no environment | Replace analysis route after provider task and consumer-contract verification; never recrawl selectedwebsite. |
| Supervisor/subscription proxy/quota/lease for migratedanalysis | Keep local executor/auth/model loop alive | Managed Agents session lifecycle | Disconnect from migratedanalysis; retire process only once nootherdependent/pendingwork. |
| Supabase/Auth/Postgres and business RPCs | Identity, tenant isolation, rules, approvals, job/result records | No equivalent substitution by these APIs | Keep and simplify only genuinelyprotocolboundfields. |
| Thin controller/sideband and function handlers | Private integration, access checks, external business effects | API still requires application execution | Keep on existingEC2 initially; no secondgenericagentharness. |
| Browser dashboard | Microphone/playback, owner controls and displayed state | Live WebRTC media/events | Keep UI; updateprotocolselectedcoherently withEdge/controller/schema. |
| EC2, volumes, backups, Hermes for otherflows | Remaining integrations and protectedexistingdata | Depends onremainingresponsibilities | Keep untildependentsverified; propose shutdown ifunneeded, neverdestroyautomatically. |

CheckpointA is LIGOU_LIVE_MANAGED_READY_FOR_HUMAN_TEST. CheckpointB is LIGOU_AGENTS_MANAGED_WORKFLOW_VERIFIED. FinalmarkerLIGOU_MANAGED_MIGRATION_ACCEPTED requires completevoice/businessacceptance, realAgentsreplacement, and removalofredundantactiveexecution. Previousnotesbelowarehistorical, notcurrentarchitectureconstraints.

---
# Live candidate status — 2026-09-10

Full objective remains active; this is not a human-ready release. Spec: IMPLEMENTATION-GOAL.md. Plan: ../superpowers/plans/2026-09-10-live1.md.

Candidate worktree: /Users/d1f/.codex/worktrees/ligou-live1-candidate/Ligou.AI, branch codex/ligou-live1-candidate. Source baseline71647ae; commits3be9c1e and655a792 implement only isolated protocol/context/Codex-client foundations. Original checkout/production remain71647ae; untracked docs/marketing preserved. No migration/deployment/provider media or paid text call ran for Live.

RJ challenged whether overlapping/late transcript handling was inherited Realtime overengineering. Rechecked exact LIVE guides via official docs connector: live-conversations#transcript-deltas, live-delegation#keep-the-conversation-context-in-your-application and#keep-updates-accurate-and-useful. Client delegation explicitly requires accumulated transcript/task context; metadata has no task text. No completed-turn event; irregular delivery does not prove silence. Voice interruption is not operation cancellation. Explain this as context retention, never as a provider-required speech gate. Removed the unsupported default30s backend deadline; only explicit task/session cancellation or an explicitly supplied existing deadline may interrupt delegated work. Context module has no timer/audio/microphone controls. Keep researching BEFORE each integration point.

Implemented (not yet wired into production entry points):
- onboarding-live-protocol.ts: actualPOST/v1/live/sessions JSON/WebRTC, client delegation, bossa/tempo, browser permission subset, opaqueID, no duplicate create on unknownoutcome, Live readiness/greeting/close lifecycle, cumulative seconds and15s initializationfloor. Finalusage confirmation separate from providerfinalization/businessapproval.
- onboarding-live-context.ts: original speaker/event/time fragments, retain earlydelegations, duplicateevent checks, latecontext in timelineorder retainingarrival, explicitsupersession only. Applicationoperationref independent of delegationID AND interpretation; payloadconflict checking belongs to transactionalstore so paraphrasedretries do not silentlyduplicateeffects. No speech control.
- onboarding-live-codex.ts: DI connection contract uses officialCodex0.154.0 stdio app-server methods/external ChatGPT tokenauth; experimentalApi, environments[], no dynamic/generaltools/apps/websearch/subagents, ephemeral customer-isolated thread, modelgpt-6-astra withoutfallback; finalstructuredoutput only afterturn/completed; explicitcancel and credentialaccountbinding. Actual transport/credentialresolver/deployment wiring and livebackend test remain pending.

Verification: nativebaseline83PASS. Liveprotocol/context23PASS; complete66-file controllergateexit0 before Codexmodule addition. Current31focusedtestsPASS (3files),892/894 stagedsecret scan clean, diffcheckclean. Foundationredmissingmodule; followupbehaviorred reproduced greetingackrace, finalusageuncertainty and operationidentityparaphrase. Tests are simulations, not audio acceptance. Lastcommit655a792. No background processes remain from npm/schema/testcalls.

Research/audit:
- FreshSSM44ef5b53-7894-41f7-b512-5741c5938142 at20:04UTC: controller71647ae/artifact363037cf… healthy,0sessions; discoverysupervisorinactive; existingcredentialownerHermescontainerUp. Voicekeypresent; GET/v1/models/gpt-live-1 HTTP200. This doesnotprove sessioncreation/audio.
- DB94,lastmigration20260908230707; bothinternalD1F/QA dailybudgetNULL andsimulation_only;0activecalls. Existingonboardinghard/reserve7.50 andsoft6.50 fromconfig; preserve. Furtherhumanfeedbackhasnotfixedprior37cfcwrongtargetanswers.
- Credentialowner container ligou-cell-a0000000-0000-4000-8000-000000000001. Correct read via resolve_codex_runtime_credentials(refresh_if_expiring=False):present/unexpired,sourcecredential_pool,expectedroute,accountfingerprintcaf6573491e9fb8dac61c12abdc5af55ae7cfcfc92965bcbaaf73c5861bfc008. Initialauthenticated:false observation was invalidfieldprojection; actualget_auth_status keys include logged_in, not authenticated. Do not repeat that false diagnosis. No CodexCLI onEC2host/container.
- Localpinned@openai/codex0.154.0 installed only in ignored output/live1-20260910/codex-runtime (binarydownload took~102s). Generated bothstable and--experimental schemas; environments[] exists onlyinexperimental output. Officialsource thread.rs/spec_plan.rs shows no environment disablesfile/applypatchtools. Must verify actual processconfiguration before production; do not substitute passing mockedrequests for it.
- Official app-serverexternal-token login documented experimental host-ownedauth, stdio mode. No newcredentials; no handcrafted ChatGPT endpointclient. ExistingHermesgrantresolver can be used for auth lifecycle, but wiring may require pinnedruntime packaging into existing immutableenvironment. Keep old discovery/text route untouched.
- OfficialSDKsnapshot openai-node/resources/live/live.ts documents client.data_channel.allowed_client_events/server_events. Livehistoryrolesdeveloper/user/assistant, no system. LiveWebRTC POSTinitializes15scredited, no session.start. Sidebandattach URL/v1/live/sessions/{id}/attach; reflectedPCM24kinput/output available, actualtimingtypeschecked. No automatedaudiocaptureclaim from armedstatus.
- Sourcesstored output/live1-20260910/research inbothoriginalandcandidate. npm registry versions queried:Codex0.154.0/sdk0.154.0/openai7.15.0. No runtimeSDK dependency changescommitted.

Next:
1. Validate restrictedstdio transport/auth using existingcredentialowner and immutablepackaging; then implement backendbusinessdecisioncontext/schema and executor. No arbitrarytools or APItextfallback. This is a protocolmigration, not modelrename.
2. Design smalleststoragegap: currentRPC/evidence schemas are genuinelybound to Realtime provider_item_id. Livehasnone. Preserve originalfragments +appoperationrefs explicitly; never put inventedIDs into provider_item_id. Reuse neutralagenda/revision/idempotency core and retain Realtimewrappers. CurrentLiveoperationhash isnot durablepersistence yet.
3. Wireprotocol6/live_client_v1 in existingauthenticatedbrowserrequest path; livebrowser/sideband; correctsubjectbasedexplicitbackendtargets (notcurrentcursorfallback), review/consent/normalclose/earlyStop. Adapt secondsaccounting; no dailycap restoration.
4. ActualQAmediaonewrite+pendingcorrection+stop, verifiablecapture, bossa/tempo audition, immutablecandidatepublish andearlyhumancheckpoint. No needthreefullinterviews. Keepgoalactive awaitinghumanacceptance.
5. AgentsAPIindependentpilot AFTERfirstvoicecheckpoint; no APIpaidtext authorization observed, so realpilot unrununlessapproved. No SIP/workforce/Presence/infrastructure rewrite.

Potential protocol review item before wiring: ifsuccessfulLiveHTTPreturns sessionID but malformed/missingSDP, creator currently throwsunknownwithout carryingknownID onerror; preserve knownID forcleanup ratherthan losingresourceidentity. Startupabort-afterPOST also needsreconciliation. Implementandtestbefore realcreation.
