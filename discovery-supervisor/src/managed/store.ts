import type { ServiceRpcClient } from "../job-store";
import { parseSourceSnapshots, type WorkerResult } from "../contracts";
import type { AnalysisIdentity, AnalysisObservation, ManagedAnalysisJob, ManagedAnalysisStore } from "./workflow";

export class ManagedDiscoveryStore implements ManagedAnalysisStore {
  constructor(private readonly rpc: ServiceRpcClient) {}
  private async action(action: string, identity: AnalysisIdentity, payload = {}): Promise<any> {
    const { data, error } = await this.rpc.rpc("company_discovery_managed_job", {
      p_action: action, p_job_id: identity.jobId, p_tenant_id: identity.tenantId, p_payload: payload,
    });
    if (error) throw new Error(`managed_analysis_${action}_failed`, { cause: error });
    return data;
  }
  private job(value: any): ManagedAnalysisJob {
    if (!value || typeof value.job_id !== "string" || typeof value.tenant_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.input_version)) throw new Error("managed_analysis_readback_invalid");
    return { ...value, source_snapshots: parseSourceSnapshots(value.source_snapshots) };
  }
  async prepare(input: { tenantId: string; sourceResultId: string; inputVersion: string; idempotencyKey: string; deadlineAt: string; retentionDeleteAt: string | null }): Promise<ManagedAnalysisJob> {
    return this.job(await this.action("prepare", { jobId: input.sourceResultId, tenantId: input.tenantId }, {
      input_version: input.inputVersion, idempotency_key: input.idempotencyKey,
      deadline_at: input.deadlineAt, retention_delete_at: input.retentionDeleteAt,
    }));
  }
  async read(identity: AnalysisIdentity) { return this.job(await this.action("read", identity)); }
  async claimLaunch(identity: AnalysisIdentity) {
    const value = await this.action("claim", identity);
    return { claimed: value.claimed === true, job: this.job(value.job) };
  }
  async bind(identity: AnalysisIdentity, sessionId: string) { await this.action("bind", identity, { session_id: sessionId }); }
  async observe(identity: AnalysisIdentity, observation: AnalysisObservation, result?: WorkerResult) {
    return this.job(await this.action("observe", identity, { observation, result: result ?? null }));
  }
  async requestCancel(identity: AnalysisIdentity) { return this.job(await this.action("cancel", identity)); }
  async findBySession(sessionId: string): Promise<ManagedAnalysisJob | null> {
    const { data, error } = await this.rpc.rpc("find_company_discovery_managed_session", { p_session_id: sessionId });
    if (error) throw new Error("managed_analysis_session_lookup_failed", { cause: error });
    return data ? this.job(data) : null;
  }
}
