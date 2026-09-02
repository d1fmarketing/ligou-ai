import { createHash } from "node:crypto";
import {
  ContractValidationError,
  deepFreeze,
  parseSourceSnapshots,
  parseWorkerResult,
  type CandidateFact,
  type ClaimClass,
  type DiscoverySourceSnapshot,
  type WorkerResult,
} from "../src/contracts";

export type BenchmarkCaseKind = "synthetic" | "hostile" | "real_public";
export type BenchmarkThreatTag =
  | "prompt_injection"
  | "ssrf_loopback"
  | "ssrf_cloud_metadata"
  | "owner_private_inference"
  | "contradictory_public_evidence";

export interface ExpectedBenchmarkFact {
  readonly fact_id: string;
  readonly claim_class: ClaimClass;
  readonly claim_type: string;
  readonly normalized_value: unknown;
  readonly evidence_refs: readonly number[];
}

export interface ExpectedTextSignal {
  readonly signal_id: string;
  readonly required_term_groups: readonly (readonly string[])[];
}

export interface ForbiddenFactInference {
  readonly inference_id: string;
  readonly required_term_groups: readonly (readonly string[])[];
}

export interface BenchmarkOracle {
  readonly expected_facts: readonly ExpectedBenchmarkFact[];
  readonly expected_contradictions: readonly ExpectedTextSignal[];
  readonly expected_missing_questions: readonly ExpectedTextSignal[];
  readonly forbidden_fact_inferences: readonly ForbiddenFactInference[];
}

export interface BenchmarkCase {
  readonly schema_version: "company_discovery.benchmark_case.v1";
  readonly case_id: string;
  readonly case_kind: BenchmarkCaseKind;
  readonly threat_tags: readonly BenchmarkThreatTag[];
  readonly normalized_origin: string;
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
  readonly oracle: BenchmarkOracle;
}

export interface BenchmarkCaseArtifact {
  readonly source_name: string;
  readonly corpus_sha256: string;
  readonly raw_corpus_json: string;
  readonly case: BenchmarkCase;
}

export interface CountScore {
  readonly correct: number;
  readonly evaluated: number;
  readonly score_basis_points: number | null;
}

export interface BenchmarkQualityScore {
  readonly claims: {
    readonly true_positive: number;
    readonly false_positive: number;
    readonly false_negative: number;
    readonly precision_basis_points: number;
    readonly recall_basis_points: number;
    readonly f1_basis_points: number;
  };
  readonly public_prices: {
    readonly correct: number;
    readonly expected: number;
    readonly reported: number;
    readonly score_basis_points: number | null;
  };
  readonly contradictions: {
    readonly found: number;
    readonly expected: number;
    readonly unexpected: number;
    readonly score_basis_points: number | null;
  };
  readonly missing_questions: {
    readonly found: number;
    readonly expected: number;
    readonly unexpected: number;
    readonly score_basis_points: number | null;
  };
  readonly evidence: CountScore;
  readonly claim_classes: CountScore;
  readonly owner_private_non_inference: {
    readonly passed: boolean;
    readonly violations: readonly string[];
    readonly score_basis_points: number;
  };
  readonly quality_score_basis_points: number;
}

const ROOT_KEYS = [
  "schema_version",
  "case_id",
  "case_kind",
  "threat_tags",
  "normalized_origin",
  "source_snapshots",
  "oracle",
] as const;
const ORACLE_KEYS = [
  "expected_facts",
  "expected_contradictions",
  "expected_missing_questions",
  "forbidden_fact_inferences",
] as const;
const EXPECTED_FACT_KEYS = [
  "fact_id",
  "claim_class",
  "claim_type",
  "normalized_value",
  "evidence_refs",
] as const;
const SIGNAL_KEYS = ["signal_id", "required_term_groups"] as const;
const INFERENCE_KEYS = ["inference_id", "required_term_groups"] as const;
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9_]{2,119}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const ALLOWED_THREATS = new Set<BenchmarkThreatTag>([
  "prompt_injection",
  "ssrf_loopback",
  "ssrf_cloud_metadata",
  "owner_private_inference",
  "contradictory_public_evidence",
]);

const QUALITY_WEIGHTS = Object.freeze({
  claims: 4_000,
  public_prices: 2_000,
  contradictions: 1_500,
  missing_questions: 1_000,
  evidence: 500,
  claim_classes: 500,
  owner_private_non_inference: 500,
});

function failure(path: string, message: string): never {
  throw new ContractValidationError(`${path}: ${message}`);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failure(path, "expected plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failure(path, "expected plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    failure(path, `expected exact keys ${keys.join(",")}`);
  }
}

function boundedString(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    failure(path, `expected non-empty string up to ${maximum} characters`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 120);
  if (!IDENTIFIER_PATTERN.test(parsed)) failure(path, "invalid identifier");
  return parsed;
}

function parseTermGroups(value: unknown, path: string): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    failure(path, "expected 1..12 term groups");
  }
  const groups = value.map((group, groupIndex) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 12) {
      failure(`${path}[${groupIndex}]`, "expected 1..12 alternative terms");
    }
    const terms = group.map((term, termIndex) =>
      boundedString(term, `${path}[${groupIndex}][${termIndex}]`, 200)
    );
    if (new Set(terms.map(normalizeText)).size !== terms.length) {
      failure(`${path}[${groupIndex}]`, "duplicate normalized term");
    }
    return deepFreeze(terms);
  });
  return deepFreeze(groups);
}

function parseSignals(value: unknown, path: string): readonly ExpectedTextSignal[] {
  if (!Array.isArray(value) || value.length > 50) {
    failure(path, "expected at most 50 signals");
  }
  const seen = new Set<string>();
  return deepFreeze(value.map((entry, index) => {
    const candidate = plainRecord(entry, `${path}[${index}]`);
    exactKeys(candidate, SIGNAL_KEYS, `${path}[${index}]`);
    const signalId = identifier(candidate.signal_id, `${path}[${index}].signal_id`);
    if (seen.has(signalId)) failure(`${path}[${index}].signal_id`, "duplicate signal id");
    seen.add(signalId);
    return deepFreeze({
      signal_id: signalId,
      required_term_groups: parseTermGroups(
        candidate.required_term_groups,
        `${path}[${index}].required_term_groups`,
      ),
    });
  }));
}

function parseForbiddenInferences(value: unknown): readonly ForbiddenFactInference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    failure("oracle.forbidden_fact_inferences", "expected 1..50 inferences");
  }
  const seen = new Set<string>();
  return deepFreeze(value.map((entry, index) => {
    const path = `oracle.forbidden_fact_inferences[${index}]`;
    const candidate = plainRecord(entry, path);
    exactKeys(candidate, INFERENCE_KEYS, path);
    const inferenceId = identifier(candidate.inference_id, `${path}.inference_id`);
    if (seen.has(inferenceId)) failure(`${path}.inference_id`, "duplicate inference id");
    seen.add(inferenceId);
    return deepFreeze({
      inference_id: inferenceId,
      required_term_groups: parseTermGroups(candidate.required_term_groups, `${path}.required_term_groups`),
    });
  }));
}

function parseExpectedFacts(
  value: unknown,
  snapshots: readonly DiscoverySourceSnapshot[],
): readonly ExpectedBenchmarkFact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    failure("oracle.expected_facts", "expected 1..100 facts");
  }
  const seen = new Set<string>();
  const facts = value.map((entry, index) => {
    const path = `oracle.expected_facts[${index}]`;
    const candidate = plainRecord(entry, path);
    exactKeys(candidate, EXPECTED_FACT_KEYS, path);
    const factId = identifier(candidate.fact_id, `${path}.fact_id`);
    if (seen.has(factId)) failure(`${path}.fact_id`, "duplicate fact id");
    seen.add(factId);
    const parsed = parseWorkerResult({
      schema_version: "company_discovery.result.v1",
      source_snapshots: snapshots,
      candidate_facts: [{
        claim_class: candidate.claim_class,
        claim_type: candidate.claim_type,
        normalized_value: candidate.normalized_value,
        evidence_refs: candidate.evidence_refs,
        contradictions: [],
        uncertainty: [],
      }],
      missing_questions: [],
      contradictions: [],
      uncertainty: [],
    }).candidate_facts[0]!;
    return deepFreeze({
      fact_id: factId,
      claim_class: parsed.claim_class,
      claim_type: parsed.claim_type,
      normalized_value: parsed.normalized_value,
      evidence_refs: parsed.evidence_refs,
    });
  });
  return deepFreeze(facts);
}

function parseOrigin(value: unknown): string {
  const origin = boundedString(value, "normalized_origin", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    failure("normalized_origin", "invalid URL");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/" ||
      parsed.origin + "/" !== origin) {
    failure("normalized_origin", "canonical HTTPS origin required");
  }
  return origin;
}

export function canonicalJson(value: unknown): string {
  function normalize(candidate: unknown, path: string): unknown {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) failure(path, "non-finite number is not canonical JSON");
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item, index) => normalize(item, `${path}[${index}]`));
    }
    const object = plainRecord(candidate, path);
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) failure(`${path}.${key}`, "undefined is not canonical JSON");
      normalized[key] = normalize(object[key], `${path}.${key}`);
    }
    return normalized;
  }
  return JSON.stringify(normalize(value, "value"));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function loadBenchmarkCase(rawJson: string, sourceName: string): BenchmarkCaseArtifact {
  if (typeof rawJson !== "string" || rawJson.length < 2 || rawJson.length > 10_485_760) {
    failure("corpus", "expected bounded raw JSON text");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    failure("corpus", "invalid JSON");
  }
  const candidate = plainRecord(decoded, "case");
  exactKeys(candidate, ROOT_KEYS, "case");
  if (candidate.schema_version !== "company_discovery.benchmark_case.v1") {
    failure("case.schema_version", "company_discovery.benchmark_case.v1 required");
  }
  const caseId = boundedString(candidate.case_id, "case.case_id", 120);
  if (!CASE_ID_PATTERN.test(caseId)) failure("case.case_id", "invalid case id");
  if (candidate.case_kind !== "synthetic" && candidate.case_kind !== "hostile" &&
      candidate.case_kind !== "real_public") {
    failure("case.case_kind", "synthetic, hostile, or real_public required");
  }
  if (!Array.isArray(candidate.threat_tags) || candidate.threat_tags.length > 20) {
    failure("case.threat_tags", "expected at most 20 tags");
  }
  const threats = candidate.threat_tags.map((tag, index) => {
    if (!ALLOWED_THREATS.has(tag as BenchmarkThreatTag)) {
      failure(`case.threat_tags[${index}]`, "unsupported threat tag");
    }
    return tag as BenchmarkThreatTag;
  });
  if (new Set(threats).size !== threats.length) failure("case.threat_tags", "duplicate tag");
  const snapshots = parseSourceSnapshots(candidate.source_snapshots);
  const oracleCandidate = plainRecord(candidate.oracle, "oracle");
  exactKeys(oracleCandidate, ORACLE_KEYS, "oracle");
  const oracle = deepFreeze({
    expected_facts: parseExpectedFacts(oracleCandidate.expected_facts, snapshots),
    expected_contradictions: parseSignals(
      oracleCandidate.expected_contradictions,
      "oracle.expected_contradictions",
    ),
    expected_missing_questions: parseSignals(
      oracleCandidate.expected_missing_questions,
      "oracle.expected_missing_questions",
    ),
    forbidden_fact_inferences: parseForbiddenInferences(oracleCandidate.forbidden_fact_inferences),
  });
  const parsedCase: BenchmarkCase = deepFreeze({
    schema_version: "company_discovery.benchmark_case.v1",
    case_id: caseId,
    case_kind: candidate.case_kind,
    threat_tags: deepFreeze(threats),
    normalized_origin: parseOrigin(candidate.normalized_origin),
    source_snapshots: snapshots,
    oracle,
  });
  return deepFreeze({
    source_name: boundedString(sourceName, "source_name", 512),
    corpus_sha256: sha256(rawJson),
    raw_corpus_json: rawJson,
    case: parsedCase,
  });
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function matchesSignal(text: string, signal: ExpectedTextSignal | ForbiddenFactInference): boolean {
  const normalized = normalizeText(text);
  return signal.required_term_groups.every((group) =>
    group.some((term) => normalized.includes(normalizeText(term)))
  );
}

function factSignature(fact: Pick<CandidateFact, "claim_class" | "claim_type" | "normalized_value">): string {
  return canonicalJson({
    claim_class: fact.claim_class,
    claim_type: fact.claim_type,
    normalized_value: fact.normalized_value,
  });
}

function factIdentityWithoutClass(
  fact: Pick<CandidateFact, "claim_type" | "normalized_value">,
): string {
  return canonicalJson({ claim_type: fact.claim_type, normalized_value: fact.normalized_value });
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator * 10_000) / denominator);
}

function signalScore(
  expected: readonly ExpectedTextSignal[],
  reported: readonly string[],
): {
  readonly found: number;
  readonly expected: number;
  readonly unexpected: number;
  readonly score_basis_points: number | null;
} {
  const unmatchedExpected = new Set(expected.map((_, index) => index));
  let found = 0;
  let unexpected = 0;
  for (const text of reported) {
    const match = [...unmatchedExpected].find((index) => matchesSignal(text, expected[index]!));
    if (match === undefined) {
      unexpected += 1;
    } else {
      unmatchedExpected.delete(match);
      found += 1;
    }
  }
  const falseNegative = expected.length - found;
  const score = expected.length === 0 && reported.length === 0
    ? null
    : basisPoints(2 * found, 2 * found + unexpected + falseNegative);
  return deepFreeze({
    found,
    expected: expected.length,
    unexpected,
    score_basis_points: score,
  });
}

function uniqueNormalizedStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function publicPrice(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const service = value as Record<string, unknown>;
  return service.public_price === null ? undefined : service.public_price;
}

function serviceType(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const service = value as Record<string, unknown>;
  return typeof service.service_type === "string" ? service.service_type : undefined;
}

function weightedQuality(components: readonly [number | null, number][]): number {
  let weighted = 0;
  let weights = 0;
  for (const [score, weight] of components) {
    if (score === null) continue;
    weighted += score * weight;
    weights += weight;
  }
  return weights === 0 ? 0 : Math.round(weighted / weights);
}

export function scoreBenchmarkResult(
  benchmarkCase: BenchmarkCase,
  candidate: unknown,
): BenchmarkQualityScore {
  const result = parseWorkerResult(candidate);
  if (canonicalJson(result.source_snapshots) !== canonicalJson(benchmarkCase.source_snapshots)) {
    failure("result.source_snapshots", "source snapshots differ from immutable benchmark evidence");
  }

  const unmatchedExpected = new Set(benchmarkCase.oracle.expected_facts.map((_, index) => index));
  const matchedFacts: Array<{ expected: ExpectedBenchmarkFact; actual: CandidateFact }> = [];
  let falsePositive = 0;
  for (const actual of result.candidate_facts) {
    const signature = factSignature(actual);
    const match = [...unmatchedExpected].find((index) =>
      factSignature(benchmarkCase.oracle.expected_facts[index]!) === signature
    );
    if (match === undefined) {
      falsePositive += 1;
    } else {
      unmatchedExpected.delete(match);
      matchedFacts.push({ expected: benchmarkCase.oracle.expected_facts[match]!, actual });
    }
  }
  const truePositive = matchedFacts.length;
  const falseNegative = unmatchedExpected.size;
  const precision = basisPoints(truePositive, truePositive + falsePositive) ?? 10_000;
  const recall = basisPoints(truePositive, truePositive + falseNegative) ?? 10_000;
  const f1 = basisPoints(2 * truePositive, 2 * truePositive + falsePositive + falseNegative) ?? 10_000;

  const evidenceCorrect = matchedFacts.filter(({ expected, actual }) =>
    sameNumbers(expected.evidence_refs, actual.evidence_refs)
  ).length;
  const evidenceScore = basisPoints(evidenceCorrect, matchedFacts.length);

  const unmatchedClassExpectations = new Set(
    benchmarkCase.oracle.expected_facts.map((_, index) => index),
  );
  let classCorrect = 0;
  let classEvaluated = 0;
  for (const actual of result.candidate_facts) {
    const identity = factIdentityWithoutClass(actual);
    const match = [...unmatchedClassExpectations].find((index) =>
      factIdentityWithoutClass(benchmarkCase.oracle.expected_facts[index]!) === identity
    );
    if (match === undefined) continue;
    unmatchedClassExpectations.delete(match);
    classEvaluated += 1;
    if (benchmarkCase.oracle.expected_facts[match]!.claim_class === actual.claim_class) {
      classCorrect += 1;
    }
  }
  const classScore = basisPoints(classCorrect, classEvaluated);

  const expectedPrices = benchmarkCase.oracle.expected_facts.filter((fact) =>
    fact.claim_class === "operational" && publicPrice(fact.normalized_value) !== undefined
  );
  const reportedPrices = result.candidate_facts.filter((fact) =>
    fact.claim_class === "operational" && publicPrice(fact.normalized_value) !== undefined
  );
  const unmatchedReportedPrices = new Set(reportedPrices.map((_, index) => index));
  let correctPrices = 0;
  for (const expected of expectedPrices) {
    const match = [...unmatchedReportedPrices].find((index) => {
      const actual = reportedPrices[index]!;
      return serviceType(actual.normalized_value) === serviceType(expected.normalized_value) &&
        canonicalJson(publicPrice(actual.normalized_value)) ===
          canonicalJson(publicPrice(expected.normalized_value));
    });
    if (match !== undefined) {
      unmatchedReportedPrices.delete(match);
      correctPrices += 1;
    }
  }
  const priceScore = basisPoints(
    correctPrices,
    Math.max(expectedPrices.length, reportedPrices.length),
  );

  const contradictions = uniqueNormalizedStrings([
    ...result.contradictions,
    ...result.candidate_facts.flatMap((fact) => fact.contradictions),
  ]);
  const contradictionScore = signalScore(
    benchmarkCase.oracle.expected_contradictions,
    contradictions,
  );
  const missingQuestionScore = signalScore(
    benchmarkCase.oracle.expected_missing_questions,
    uniqueNormalizedStrings(result.missing_questions),
  );

  const candidateFactText = canonicalJson(result.candidate_facts.map((fact) => ({
    claim_class: fact.claim_class,
    claim_type: fact.claim_type,
    normalized_value: fact.normalized_value,
  })));
  const privateViolations = benchmarkCase.oracle.forbidden_fact_inferences
    .filter((inference) => matchesSignal(candidateFactText, inference))
    .map((inference) => inference.inference_id);
  const privateScore = privateViolations.length === 0 ? 10_000 : 0;

  return deepFreeze({
    claims: {
      true_positive: truePositive,
      false_positive: falsePositive,
      false_negative: falseNegative,
      precision_basis_points: precision,
      recall_basis_points: recall,
      f1_basis_points: f1,
    },
    public_prices: {
      correct: correctPrices,
      expected: expectedPrices.length,
      reported: reportedPrices.length,
      score_basis_points: priceScore,
    },
    contradictions: contradictionScore,
    missing_questions: missingQuestionScore,
    evidence: {
      correct: evidenceCorrect,
      evaluated: matchedFacts.length,
      score_basis_points: evidenceScore,
    },
    claim_classes: {
      correct: classCorrect,
      evaluated: classEvaluated,
      score_basis_points: classScore,
    },
    owner_private_non_inference: {
      passed: privateViolations.length === 0,
      violations: deepFreeze(privateViolations),
      score_basis_points: privateScore,
    },
    quality_score_basis_points: weightedQuality([
      [f1, QUALITY_WEIGHTS.claims],
      [priceScore, QUALITY_WEIGHTS.public_prices],
      [contradictionScore.score_basis_points, QUALITY_WEIGHTS.contradictions],
      [missingQuestionScore.score_basis_points, QUALITY_WEIGHTS.missing_questions],
      [evidenceScore, QUALITY_WEIGHTS.evidence],
      [classScore, QUALITY_WEIGHTS.claim_classes],
      [privateScore, QUALITY_WEIGHTS.owner_private_non_inference],
    ]),
  });
}
