import {
  ContractValidationError,
  deepFreeze,
  parseWorkerHandle,
  parseWorkerJob,
  parseWorkerResult,
  type CandidateFact,
  type DiscoverySourceSnapshot,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerJob,
  type WorkerJobType,
  type WorkerResult,
  type WorkerState,
  type WorkerStatus,
} from "../contracts";

export interface DirectModelRequest {
  readonly schema_version: "company_discovery.model-output.v1";
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
}

export interface DirectModelTransport {
  generate(
    request: DirectModelRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

interface DirectModelCandidate {
  readonly candidate_facts: readonly CandidateFact[];
  readonly missing_questions: readonly string[];
  readonly contradictions: readonly string[];
  readonly uncertainty: Readonly<Record<string, unknown>>;
}

interface Execution {
  readonly handle: WorkerHandle;
  readonly controller: AbortController;
  state: WorkerState;
  result?: WorkerResult;
  error?: Error;
  completion: Promise<void>;
}

const MODEL_RESULT_KEYS = [
  "candidate_facts",
  "missing_questions",
  "contradictions",
  "uncertainty",
] as const;

function executionKey(handle: WorkerHandle): string {
  return `${handle.job_id}:${handle.attempt_id}:${handle.fence_generation}`;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function modelCandidate(value: unknown): DirectModelCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("model result: expected object");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== MODEL_RESULT_KEYS.length || MODEL_RESULT_KEYS.some((key) => !keys.includes(key))) {
    throw new ContractValidationError("model result: exact bounded candidate keys required");
  }
  return candidate as unknown as DirectModelCandidate;
}

export class DirectModelDiscoveryAdapter implements WorkerAdapter {
  readonly #executions = new Map<string, Execution>();

  constructor(private readonly transport: DirectModelTransport) {}

  supports(jobType: WorkerJobType): boolean {
    return jobType === "company_discovery.v1";
  }

  async submit(candidate: WorkerJob): Promise<WorkerHandle> {
    const job = parseWorkerJob(candidate);
    const handle = parseWorkerHandle({
      adapter_id: "direct_model",
      job_type: job.job_type,
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      fence_generation: job.fence_generation,
    });
    const key = executionKey(handle);
    if (this.#executions.has(key)) {
      throw new ContractValidationError("direct model attempt already submitted");
    }
    const controller = new AbortController();
    const execution: Execution = {
      handle,
      controller,
      state: "running",
      completion: Promise.resolve(),
    };
    const request = deepFreeze({
      schema_version: "company_discovery.model-output.v1" as const,
      source_snapshots: job.source_snapshots,
    });
    execution.completion = this.run(execution, request, job.source_snapshots);
    this.#executions.set(key, execution);
    return handle;
  }

  async cancel(candidate: WorkerHandle): Promise<void> {
    const execution = this.execution(candidate);
    if (execution.state === "running") {
      execution.state = "cancelled";
      execution.controller.abort();
    }
  }

  async status(candidate: WorkerHandle): Promise<WorkerStatus> {
    return deepFreeze({ state: this.execution(candidate).state });
  }

  async result(candidate: WorkerHandle): Promise<WorkerResult> {
    const execution = this.execution(candidate);
    await execution.completion;
    if (execution.state === "cancelled") throw new Error("direct model attempt cancelled");
    if (execution.state === "failed") throw execution.error ?? new Error("direct model attempt failed");
    if (execution.state !== "succeeded" || execution.result === undefined) {
      throw new Error("direct model result unavailable");
    }
    return execution.result;
  }

  private async run(
    execution: Execution,
    request: DirectModelRequest,
    snapshots: readonly DiscoverySourceSnapshot[],
  ): Promise<void> {
    try {
      const candidate = modelCandidate(await this.transport.generate(request, {
        signal: execution.controller.signal,
      }));
      const result = parseWorkerResult({
        schema_version: "company_discovery.result.v1",
        source_snapshots: snapshots,
        candidate_facts: candidate.candidate_facts,
        missing_questions: candidate.missing_questions,
        contradictions: candidate.contradictions,
        uncertainty: candidate.uncertainty,
      });
      if (execution.state === "running") {
        execution.result = result;
        execution.state = "succeeded";
      }
    } catch (error) {
      if (execution.state === "running") {
        execution.error = errorFrom(error);
        execution.state = "failed";
      }
    }
  }

  private execution(candidate: WorkerHandle): Execution {
    const handle = parseWorkerHandle(candidate);
    if (handle.adapter_id !== "direct_model") {
      throw new ContractValidationError("direct model handle required");
    }
    const execution = this.#executions.get(executionKey(handle));
    if (execution === undefined) throw new ContractValidationError("direct model attempt not found");
    return execution;
  }
}
