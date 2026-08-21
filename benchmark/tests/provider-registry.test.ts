import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const REGISTRY_URL = new URL("../config/candidates.json", import.meta.url);
const EVIDENCE_DATE = "2026-08-21";
const QUALIFICATION_RESULTS = [
  "QUALIFIED",
  "CONDITIONALLY_QUALIFIED",
  "INCOMPATIBLE",
  "NOT_VERIFIABLE",
] as const;
const REQUIRED_PREDICATES = [
  "bidirectional_streaming_audio",
  "caller_interruption",
  "programmatic_session_termination",
  "deterministic_tool_call_events",
  "ligou_retains_tool_authority",
  "transcript_evidence",
  "usage_cost_evidence",
  "automated_execution",
  "identifiable_model_version",
  "no_external_credentials_to_model",
] as const;
const REQUIRED_COMPATIBILITY_CAPABILITIES = [
  "function_calling",
  "server_authoritative_tool_execution",
  "transcript_events",
  "usage_telemetry",
  "cost_telemetry",
] as const;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

type Registry = {
  schema: string;
  evidence_date: string;
  candidates: Candidate[];
};

type Evidence = {
  value: boolean;
  official_urls: string[];
  note: string;
};

type Candidate = {
  id: string;
  provider: string;
  model: string;
  pinning: { supported: boolean; pinned_model: string | null; note: string };
  voice: string;
  api_version: string;
  transport: string;
  interruption_configuration: Record<string, unknown>;
  tool_configuration: Record<string, unknown>;
  capabilities: Record<string, boolean>;
  qualification_predicates: Record<string, Evidence>;
  session_termination: { method: string; official_urls: string[] };
  session_duration_limits: { value: string; official_urls: string[] };
  audio_formats: { input: string[]; output: string[]; official_urls: string[] };
  concurrency_rate_limits: { value: string; official_urls: string[] };
  regional_restrictions: { value: string; official_urls: string[] };
  pricing_snapshot: {
    date: string;
    currency: string;
    basis: string;
    rates: Record<string, number>;
    limitations: string;
    official_urls: string[];
  };
  credential_env_vars: string[];
  qualification: { result: (typeof QUALIFICATION_RESULTS)[number]; reason: string };
  selected_for_v1: boolean;
  official_urls: string[];
};

function loadRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY_URL, "utf8")) as Registry;
}

function isOfficialHttpsUrl(value: string, provider: string): boolean {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) return false;

  const providerHostSuffixes: Record<string, string[]> = {
    OpenAI: ["openai.com"],
    Google: ["google.dev", "googleapis.com"],
    xAI: ["x.ai"],
    ElevenLabs: ["elevenlabs.io"],
    Deepgram: ["deepgram.com"],
  };
  const suffixes = providerHostSuffixes[provider] ?? [];
  return suffixes.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  );
}

function exactIdentity(candidate: Candidate): string {
  return JSON.stringify([
    candidate.provider,
    candidate.model,
    candidate.pinning.pinned_model,
    candidate.voice,
    candidate.api_version,
    candidate.transport,
    candidate.interruption_configuration,
    candidate.tool_configuration,
  ]);
}

describe("voice candidate registry", () => {
  test("contains one to five unique exact candidate configurations", () => {
    const registry = loadRegistry();

    expect(registry.schema).toBe("ligou.voice-gauntlet.candidates.v1");
    expect(registry.candidates.length).toBeGreaterThanOrEqual(1);
    expect(registry.candidates.length).toBeLessThanOrEqual(5);

    const ids = registry.candidates.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toBe(true);

    const identities = registry.candidates.map(exactIdentity);
    expect(new Set(identities).size).toBe(identities.length);

    for (const candidate of registry.candidates) {
      expect(candidate.provider.trim().length).toBeGreaterThan(0);
      expect(candidate.model.trim().length).toBeGreaterThan(0);
      expect(candidate.voice.trim().length).toBeGreaterThan(0);
      expect(candidate.api_version.trim().length).toBeGreaterThan(0);
      expect(candidate.transport.trim().length).toBeGreaterThan(0);
      expect(Object.keys(candidate.interruption_configuration).length).toBeGreaterThan(0);
      expect(Object.keys(candidate.tool_configuration).length).toBeGreaterThan(0);
      expect(candidate.pinning.note.trim().length).toBeGreaterThan(0);
      if (candidate.pinning.supported) {
        expect(candidate.pinning.pinned_model).toBe(candidate.model);
      } else {
        expect(candidate.pinning.pinned_model).toBeNull();
      }
    }
  });

  test("uses the required evidence date and provider-owned HTTPS references", () => {
    const registry = loadRegistry();

    expect(registry.evidence_date).toBe(EVIDENCE_DATE);
    for (const candidate of registry.candidates) {
      expect(candidate.pricing_snapshot.date).toBe(EVIDENCE_DATE);
      expect(candidate.official_urls.length).toBeGreaterThan(0);
      expect(new Set(candidate.official_urls).size).toBe(candidate.official_urls.length);
      expect(
        candidate.official_urls.every((url) => isOfficialHttpsUrl(url, candidate.provider)),
      ).toBe(true);

      for (const predicate of REQUIRED_PREDICATES) {
        const evidence = candidate.qualification_predicates[predicate];
        expect(evidence.note.trim().length).toBeGreaterThan(0);
        expect(evidence.official_urls.length).toBeGreaterThan(0);
        expect(
          evidence.official_urls.every(
            (url) =>
              candidate.official_urls.includes(url) &&
              isOfficialHttpsUrl(url, candidate.provider),
          ),
        ).toBe(true);
      }
    }
  });

  test("records every required compatibility field explicitly", () => {
    const registry = loadRegistry();

    for (const candidate of registry.candidates) {
      for (const capability of REQUIRED_COMPATIBILITY_CAPABILITIES) {
        expect(typeof candidate.capabilities[capability]).toBe("boolean");
      }
      expect(candidate.session_termination.method.trim().length).toBeGreaterThan(0);
      expect(candidate.session_duration_limits.value.trim().length).toBeGreaterThan(0);
      expect(candidate.audio_formats.input.length).toBeGreaterThan(0);
      expect(candidate.audio_formats.output.length).toBeGreaterThan(0);
      expect(candidate.concurrency_rate_limits.value.trim().length).toBeGreaterThan(0);
      expect(candidate.regional_restrictions.value.trim().length).toBeGreaterThan(0);
      expect(candidate.pricing_snapshot.currency).toBe("USD");
      expect(candidate.pricing_snapshot.basis.trim().length).toBeGreaterThan(0);
      expect(Object.keys(candidate.pricing_snapshot.rates).length).toBeGreaterThan(0);
      expect(candidate.pricing_snapshot.limitations.trim().length).toBeGreaterThan(0);
      expect(candidate.qualification.reason.trim().length).toBeGreaterThan(0);
      expect(QUALIFICATION_RESULTS).toContain(candidate.qualification.result);
    }
  });

  test("stores credential variable names and never credential values", () => {
    const registry = loadRegistry();

    for (const candidate of registry.candidates) {
      expect(candidate.credential_env_vars.length).toBeGreaterThan(0);
      expect(candidate.credential_env_vars.every((name) => ENV_NAME.test(name))).toBe(true);
      expect(new Set(candidate.credential_env_vars).size).toBe(
        candidate.credential_env_vars.length,
      );
    }
  });

  test("qualifies and selects candidates only when all ten predicates are true", () => {
    const registry = loadRegistry();

    for (const candidate of registry.candidates) {
      const predicates = REQUIRED_PREDICATES.map((name) => {
        const evidence = candidate.qualification_predicates[name];
        expect(typeof evidence.value).toBe("boolean");
        expect(candidate.capabilities[name]).toBe(evidence.value);
        return evidence.value;
      });
      const allRequiredPredicates = predicates.every(Boolean);

      if (candidate.qualification.result === "QUALIFIED") {
        expect(allRequiredPredicates).toBe(true);
      }
      if (candidate.selected_for_v1) {
        expect(candidate.qualification.result).toBe("QUALIFIED");
        expect(allRequiredPredicates).toBe(true);
      }
    }
  });
});
