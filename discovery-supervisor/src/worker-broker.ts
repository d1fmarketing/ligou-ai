import {
  ContractValidationError,
  isDiscoveryAdapterId,
  parseWorkerHandle,
  parseWorkerJob,
  parseWorkerResult,
  parseWorkerStatus,
  type DiscoveryAdapterId,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerJob,
  type WorkerResult,
  type WorkerStatus,
} from "./contracts";

export type WorkerAdapterRegistry = Partial<Record<DiscoveryAdapterId, WorkerAdapter>>;

export class WorkerBroker {
  readonly #adapters: WorkerAdapterRegistry;

  constructor(adapters: WorkerAdapterRegistry) {
    this.#adapters = { ...adapters };
  }

  async submit(adapterId: DiscoveryAdapterId, candidate: WorkerJob): Promise<WorkerHandle> {
    if (!isDiscoveryAdapterId(adapterId)) {
      throw new ContractValidationError("adapter: only openclaw or direct_model allowed");
    }
    const adapter = this.#adapters[adapterId];
    if (adapter === undefined) throw new ContractValidationError(`adapter unavailable: ${adapterId}`);
    const job = parseWorkerJob(candidate);
    if (!adapter.supports(job.job_type)) {
      throw new ContractValidationError(`adapter does not support ${job.job_type}`);
    }
    const handle = parseWorkerHandle(await adapter.submit(job));
    if (handle.adapter_id !== adapterId || handle.job_type !== job.job_type ||
        handle.job_id !== job.job_id || handle.attempt_id !== job.attempt_id ||
        handle.fence_generation !== job.fence_generation) {
      throw new ContractValidationError("adapter returned mismatched handle identity");
    }
    return handle;
  }

  async cancel(candidate: WorkerHandle): Promise<void> {
    const handle = parseWorkerHandle(candidate);
    await this.adapterFor(handle).cancel(handle);
  }

  async status(candidate: WorkerHandle): Promise<WorkerStatus> {
    const handle = parseWorkerHandle(candidate);
    return parseWorkerStatus(await this.adapterFor(handle).status(handle));
  }

  async result(candidate: WorkerHandle): Promise<WorkerResult> {
    const handle = parseWorkerHandle(candidate);
    return parseWorkerResult(await this.adapterFor(handle).result(handle));
  }

  private adapterFor(handle: WorkerHandle): WorkerAdapter {
    const adapter = this.#adapters[handle.adapter_id];
    if (adapter === undefined) {
      throw new ContractValidationError(`adapter unavailable: ${handle.adapter_id}`);
    }
    return adapter;
  }
}
