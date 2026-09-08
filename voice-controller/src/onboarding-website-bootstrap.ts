import { buildCompanyDiscoveryPrefill } from "./company-discovery-prefill.ts";
import { createOnboardingAgenda } from "./onboarding-agenda.ts";
import { createOnboardingAgendaStore, type InterviewScope, type StoredWebsiteInterview } from "./onboarding-agenda-store.ts";
import { buildWebsiteAgendaSeeds, type WebsiteAgendaSeedProjection } from "./onboarding-agenda-seed.ts";
import type { CoverageSnapshot } from "./onboarding-coverage.ts";
import { buildWebsiteCandidateContext } from "./onboarding-website-summary.ts";

export interface PreparedWebsiteInterview {
  scope: InterviewScope;
  stored: StoredWebsiteInterview;
  projection: WebsiteAgendaSeedProjection;
}

/** A prepared voice attempt starts from the immutable selected candidate, never
 * from a failed call's mutable checkpoint. The RPC owns tenant/source authority. */
export async function prepareWebsiteInterview(
  scope: InterviewScope & { tenantId: string },
  client: Parameters<typeof createOnboardingAgendaStore>[0],
): Promise<PreparedWebsiteInterview | null> {
  const store = createOnboardingAgendaStore(client);
  const source = await store.resolvePreparedWebsiteSource(scope);
  if (!source) return null;
  const prefill = buildCompanyDiscoveryPrefill({ tenant_id: scope.tenantId,
    call_id: scope.callId, draft_readback: source.draft_readback, localities: [] });
  const projection = buildWebsiteAgendaSeeds({ draftReadback: source.draft_readback,
    initialCoverage: prefill.coverage.snapshot as CoverageSnapshot });
  const provenance = projection.provenance;
  if (source.draftId !== provenance.draftId || source.draftHash !== provenance.draftHash ||
    source.sourceResultId !== provenance.sourceResultId || source.sourceResultHash !== provenance.sourceResultHash)
    throw new Error("Website interview source binding mismatch");
  const agenda = createOnboardingAgenda({ interviewId: scope.callId, callId: scope.callId,
    draftId: source.draftId, draftHash: source.draftHash,
    sourceResultId: source.sourceResultId, sourceResultHash: source.sourceResultHash }, projection.seeds, buildWebsiteCandidateContext(projection),projection.contextTimezone);
  const stored = source.resume
    ? await store.attachWebsiteInterview({ ...scope, ...source.resume })
    : await store.initializeWebsiteInterview({ ...scope, preparationId: source.preparationId, agenda });
  return { scope: { ownerId: scope.ownerId, callId: scope.callId, requestId: scope.requestId }, stored, projection };
}
