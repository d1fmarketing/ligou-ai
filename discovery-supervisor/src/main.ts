import type { ServiceRpcClient } from "./job-store";
import type { DiscoveryAdapterId, WorkerHandle, WorkerJob } from "./contracts";
import { JobStore } from "./job-store";
import { WorkerBroker } from "./worker-broker";
import {
  createDiscoveryAttemptContext,
  DiscoveryFetchGateway,
} from "./fetch/discovery-fetch-gateway";
import { DirectModelDiscoveryAdapter } from "./adapters/direct-model";
import {
  EphemeralOpenClawAttemptFactory,
  OpenClawDiscoveryAdapter,
} from "./adapters/openclaw";
import {
  CellRuntime,
  type CommandRunner,
  type LocalOpenClawCleanupProof,
} from "./openclaw/cell-runtime";
import { OpenClawGatewayClient } from "./openclaw/gateway-client";
import {
  HermesCodexGrantResolver,
  type CredentialOwnerCommandRunner,
} from "./openclaw/hermes-codex-grant";
import {
  CentralSubscriptionGateway,
  UnixSubscriptionListenerManager,
  type SubscriptionListenerManager,
  type SubscriptionRuntimeRootReadback,
} from "./openclaw/subscription-gateway";
import {
  allocateDirectModelRuntimeIdentity,
  allocateRuntimeIdentity,
  AttemptRuntimeIdentityRegistry,
  type RuntimeIdentity,
  type RuntimeIdentityBinding,
} from "./openclaw/runtime-identity";
import {
  DiscoverySupervisor,
  type DirectModelLocalCleanupProof,
  type DirectModelRetirementReadback,
} from "./supervisor";
import {
  ReleaseCredentialOwnerRegistry,
  assertSupervisorIdentity,
  loadProtectedSecret,
  readSupervisorConfig,
  type SupervisorRuntimeConfig,
} from "./runtime/config";
import { ArgvCommandRunner } from "./runtime/command-runner";
import {
  HealthEndpoint,
  SingletonAuthority,
  SupervisorLoop,
  SupervisorService,
} from "./runtime/process";
import {
  proveDockerIdentityProcessesAbsent,
  proveLoopbackListenerClosed,
} from "./runtime/proofs";
import {
  SupabaseServiceRpcClient,
  type ServiceRpcFetch,
} from "./runtime/service-rpc";

interface PreparedSubscriptionListenerManager extends SubscriptionListenerManager {
  prepareRuntimeRoot(): Promise<SubscriptionRuntimeRootReadback>;
}

export interface ProductionCompositionDependencies {
  readonly rpc_client?: ServiceRpcClient;
  readonly rpc_fetch?: ServiceRpcFetch;
  readonly model_fetch?: ServiceRpcFetch;
  readonly command_runner?: CredentialOwnerCommandRunner;
  readonly listener_manager?: PreparedSubscriptionListenerManager;
  readonly gateway_client?: OpenClawGatewayClient;
  readonly fetch_gateway?: DiscoveryFetchGateway;
  readonly cell_runtime?: CellRuntime;
  readonly now?: () => number;
}

export interface ProductionSupervisorComposition {
  readonly adapter_ids: readonly ["direct_model", "openclaw"];
  run_once(signal?: AbortSignal): Promise<{ readonly state: string }>;
}

function directLocalCleanupProof(): DirectModelLocalCleanupProof {
  return Object.freeze({
    runtime_kind: "direct_model_subscription",
    identity_process_absent: true,
  });
}

function openClawIdentity(value: ReturnType<AttemptRuntimeIdentityRegistry["resolve"]>): RuntimeIdentity {
  if (value.runtime_kind !== "openclaw_cell") {
    throw new Error("OpenClaw attempt resolved a non-cell runtime identity");
  }
  return value;
}

export async function composeProductionSupervisor(
  config: SupervisorRuntimeConfig,
  serviceKey: string,
  dependencies: ProductionCompositionDependencies = {},
): Promise<ProductionSupervisorComposition> {
  const rpcClient = dependencies.rpc_client ?? new SupabaseServiceRpcClient({
    url: config.supabase_url,
    service_key: serviceKey,
    fetch: dependencies.rpc_fetch,
  });
  const store = new JobStore(rpcClient);
  const commandRunner = dependencies.command_runner ?? new ArgvCommandRunner();
  const ownerRegistry = new ReleaseCredentialOwnerRegistry(config.credential_owners);
  const owner = config.credential_owners[0]!;
  const ownerBinding = Object.freeze({
    credential_owner_id: owner.credential_owner_id,
    credential_generation: owner.credential_generation,
    account_id_sha256: owner.account_id_sha256,
  });
  const grantResolver = new HermesCodexGrantResolver({
    command_runner: commandRunner,
    credential_owner_registry: ownerRegistry,
    now: dependencies.now,
  });
  const listenerManager = dependencies.listener_manager ?? new UnixSubscriptionListenerManager({
    supervisor_uid: config.supervisor_uid,
  });
  const root = await listenerManager.prepareRuntimeRoot();
  if (root.owner_uid !== config.supervisor_uid || root.bridge_uid !== 1_000 ||
      root.bridge_gid !== config.supervisor_gid || root.mode !== 0o710 ||
      root.no_symlink !== true) {
    throw new Error("subscription runtime root differs from release authority");
  }
  const subscriptionGateway = new CentralSubscriptionGateway({
    model_access_authority: store,
    quota_recovery_authority: store,
    quota_recovery_worker_id: `${config.worker_id}-quota-recovery`,
    credential_owner: ownerBinding,
    resolve_codex_grant: (binding, deadlineAt) => grantResolver.resolve(binding, deadlineAt),
    listener_manager: listenerManager,
    fetch: dependencies.model_fetch ?? globalThis.fetch,
    now: dependencies.now,
    revoke_drain_timeout_ms: Math.min(30_000, config.shutdown_timeout_ms),
  });
  const cellRuntime = dependencies.cell_runtime ?? new CellRuntime({
    command_runner: commandRunner as CommandRunner,
    listener_closed: (identity) => proveLoopbackListenerClosed(identity.host_gateway_port),
    identity_process_absent: (identity) =>
      proveDockerIdentityProcessesAbsent(commandRunner, identity),
  });
  const runtimeIdentities = new AttemptRuntimeIdentityRegistry();
  const gatewayClient = dependencies.gateway_client ?? new OpenClawGatewayClient();
  const openClawFactory = new EphemeralOpenClawAttemptFactory({
    runtime: cellRuntime,
    gateway_client: gatewayClient,
    upstream_model: "gpt-5.6-sol",
    resolve_identity: async (job) => openClawIdentity(runtimeIdentities.resolve(job)),
    subscription_gateway: subscriptionGateway,
  });
  const directAdapter = new DirectModelDiscoveryAdapter({
    subscription_gateway: subscriptionGateway,
  });
  const openClawAdapter = new OpenClawDiscoveryAdapter({ attempts: openClawFactory });
  const broker = new WorkerBroker({
    direct_model: directAdapter,
    openclaw: openClawAdapter,
  }, store);
  const fetchGateway = dependencies.fetch_gateway ?? new DiscoveryFetchGateway();
  const supervisorFetchGateway = {
    createAttemptContext(job: WorkerJob, signal?: AbortSignal) {
      return createDiscoveryAttemptContext({
        normalized_origin: job.normalized_origin,
        deadline_at: job.deadline_at,
        budget: job.budget,
        signal,
      });
    },
    crawl(context: object, originUrl: string) {
      return fetchGateway.crawl(
        context as ReturnType<typeof createDiscoveryAttemptContext>,
        originUrl,
      );
    },
    retireAttempt(context: object) {
      fetchGateway.retireAttempt(context as ReturnType<typeof createDiscoveryAttemptContext>);
    },
  };

  const retireWorker = async (
    handle: WorkerHandle,
  ): Promise<LocalOpenClawCleanupProof | DirectModelRetirementReadback> => {
    if (handle.adapter_id === "openclaw") return openClawAdapter.retire(handle);
    const revocation = await directAdapter.retire(handle);
    return Object.freeze({ ...directLocalCleanupProof(), revocation });
  };
  const cleanupBoundRuntime = (
    binding: RuntimeIdentityBinding,
  ) => binding.runtime_kind === "openclaw_cell"
    ? cellRuntime.cleanupBoundRuntime(binding)
    : Promise.resolve(directLocalCleanupProof());
  const supervisors = new Map<DiscoveryAdapterId, DiscoverySupervisor>();
  for (const adapterId of ["direct_model", "openclaw"] as const) {
    supervisors.set(adapterId, new DiscoverySupervisor({
      worker_id: `${config.worker_id}-${adapterId}`,
      store,
      broker,
      fetch_gateway: supervisorFetchGateway,
      select_adapter: () => adapterId,
      allocate_runtime_identity: async () => adapterId === "openclaw"
        ? allocateRuntimeIdentity({ image_evidence: config.image_evidence })
        : allocateDirectModelRuntimeIdentity(),
      runtime_identities: runtimeIdentities,
      subscription_gateway: subscriptionGateway,
      retire_worker: retireWorker,
      cleanup_bound_runtime: cleanupBoundRuntime,
      now: dependencies.now,
      lease_seconds: config.lease_seconds,
    }));
  }
  let next = 0;
  const sequence = config.adapter_sequence;
  return Object.freeze({
    adapter_ids: Object.freeze(["direct_model", "openclaw"] as const),
    async run_once(signal?: AbortSignal) {
      // Cleanup proof is host- and adapter-worker-bound. Poll both stable
      // worker identities even when a release temporarily admits new work for
      // only one adapter, so a rollout cannot strand the deselected runtime.
      for (const cleanupAdapter of ["direct_model", "openclaw"] as const) {
        const recovered = await supervisors.get(cleanupAdapter)!.recoverExpiredCleanup();
        if (recovered !== null) return recovered;
      }
      const quotaRecovery = await subscriptionGateway.recoverStaleQuota();
      if (quotaRecovery.state !== "idle") return quotaRecovery;
      const adapterId = sequence[next % sequence.length]!;
      next += 1;
      return supervisors.get(adapterId)!.runOnce(signal, { recover_expired_cleanup: false });
    },
  });
}

export function supervisorCredentialPaths(
  argv: readonly string[],
  environment: Pick<NodeJS.ProcessEnv, "CREDENTIALS_DIRECTORY">,
): { readonly config_path: string; readonly service_key_path: string } {
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (typeof directory !== "string" ||
      !/^\/run\/credentials\/[A-Za-z0-9_.@-]{1,200}$/.test(directory)) {
    throw new Error("systemd credential directory is unavailable or invalid");
  }
  const configPath = `${directory}/supervisor_config`;
  if (argv.length !== 2 || argv[0] !== "--config" || argv[1] !== configPath) {
    throw new Error("supervisor config credential path is invalid");
  }
  return Object.freeze({
    config_path: configPath,
    service_key_path: `${directory}/supabase_service_key`,
  });
}

export async function runSupervisorMain(
  argv: readonly string[] = process.argv.slice(2),
  environment: Pick<NodeJS.ProcessEnv, "CREDENTIALS_DIRECTORY"> = {
    CREDENTIALS_DIRECTORY: process.env.CREDENTIALS_DIRECTORY,
  },
): Promise<void> {
  const credentials = supervisorCredentialPaths(argv, environment);
  const config = await readSupervisorConfig(credentials.config_path);
  assertSupervisorIdentity(config);
  const serviceKey = await loadProtectedSecret(
    credentials.service_key_path,
    "Supabase service key",
  );
  const authority = await SingletonAuthority.acquire(config.singleton_directory);
  let service: SupervisorService | undefined;
  const stop = new AbortController();
  const stopSignal = (): void => stop.abort();
  process.once("SIGINT", stopSignal);
  process.once("SIGTERM", stopSignal);
  try {
    const composition = await composeProductionSupervisor(config, serviceKey);
    const loop = new SupervisorLoop({
      run_once: (signal) => composition.run_once(signal),
      poll_interval_ms: config.poll_interval_ms,
    });
    const health = new HealthEndpoint({
      host: config.health_host,
      port: config.health_port,
      state: loop.health,
    });
    service = new SupervisorService({
      loop,
      health,
      authority,
      shutdown_timeout_ms: config.shutdown_timeout_ms,
    });
    await service.start();
    if (!stop.signal.aborted) {
      await new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }));
    }
    const shutdown = await service.shutdown();
    if (!shutdown.drained) throw new Error("supervisor shutdown did not drain");
  } catch (error) {
    if (service === undefined) await authority.release().catch(() => undefined);
    else await service.shutdown().catch(() => undefined);
    throw error;
  } finally {
    process.removeListener("SIGINT", stopSignal);
    process.removeListener("SIGTERM", stopSignal);
  }
}

if (import.meta.main) {
  void runSupervisorMain().catch(() => {
    process.stderr.write("Ligou discovery supervisor failed\n");
    process.exitCode = 1;
  });
}
