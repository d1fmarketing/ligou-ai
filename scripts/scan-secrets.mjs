#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const placeholder = /^(?:|change-me|example|placeholder|replace-me|your[-_].*|\$\{[^}]+\}|<[^>]+>)$/i;
const envAssignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;
const structuredAssignment = /^\s*(?:"([A-Za-z][A-Za-z0-9_-]*)"|'([A-Za-z][A-Za-z0-9_-]*)'|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*(.*?)\s*,?\s*$/;
const sensitiveStructuredNames = new Set([
  "access_token", "accesstoken", "client_secret", "clientsecret", "database_url", "databaseurl",
  "github_token", "githubtoken", "private_key", "privatekey", "refresh_token", "refreshtoken",
  "service_role", "servicerole", "service_role_key", "servicerolekey",
]);
const tokenPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const pemPrivateKey = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{16,}?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function stripTrailingComment(raw) {
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if ((character === '"' || character === "'") && raw[index - 1] !== "\\") {
      quote = quote === character ? null : (quote ?? character);
      continue;
    }
    if (character === "#" && quote === null) return raw.slice(0, index);
  }
  return raw;
}

export function normaliseValue(raw) {
  const value = stripTrailingComment(raw).trim().replace(/,$/, "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isSensitiveEnvironmentName(name) {
  return !new Set(["KEY", "SECRET", "TOKEN", "PASSWORD"]).has(name)
    && (/(?:^|_)(?:API_)?(?:KEY|SECRET|TOKEN|PASSWORD)$/.test(name)
    || /(?:^|_)(?:DATABASE|DIRECT|POSTGRES|MYSQL|MONGO|REDIS)_URL$/.test(name)
    || /(?:^|_)(?:PRIVATE_KEY|JWT)$/.test(name));
}

function isRuntimeExpression(raw) {
  const value = raw.trim();
  return /^(?:process|Deno|Bun)\.env\b/.test(value)
    || /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+/.test(value);
}

function finding(pathname, line, category, value) {
  return { path: pathname, line, category, fingerprint: fingerprint(value) };
}

function addStructuredFinding(findings, filePath, line, rawName, rawValue) {
  const name = rawName.replace(/-/g, "_").toLowerCase();
  const value = normaliseValue(rawValue);
  if (sensitiveStructuredNames.has(name) && !placeholder.test(value) && !isRuntimeExpression(rawValue)) {
    findings.push(finding(filePath, line, "structured-secret-value", value));
  }
}

export function scanText(text, filePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const assignment = line.match(envAssignment);
    if (assignment && isSensitiveEnvironmentName(assignment[1])) {
      const value = normaliseValue(assignment[2]);
      if (!placeholder.test(value)) {
        findings.push(finding(filePath, index + 1, "named-secret-assignment", value));
      }
    }

    if (/\.(?:json|ya?ml)$/i.test(filePath)) {
      const structured = line.match(structuredAssignment);
      if (structured) {
        addStructuredFinding(findings, filePath, index + 1, structured[1] ?? structured[2] ?? structured[3], structured[4]);
      }
      for (const jsonMatch of line.matchAll(/"([A-Za-z][A-Za-z0-9_-]*)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/g)) {
        addStructuredFinding(findings, filePath, index + 1, jsonMatch[1], jsonMatch[2]);
      }
    }

    for (const pattern of tokenPatterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        findings.push(finding(filePath, index + 1, "credential-shaped-token", match[0]));
      }
    }
  }

  pemPrivateKey.lastIndex = 0;
  for (const match of text.matchAll(pemPrivateKey)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    findings.push(finding(filePath, line, "private-key-material", match[0]));
  }
  return findings;
}

async function readTrackedRegularFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const stats = await lstat(filePath);
  if (!stats.isFile()) return null;
  const contents = await readFile(filePath);
  return contents.includes(0) ? null : contents.toString("utf8");
}

export async function scanRepositoryFiles(root, files) {
  const findings = [];
  for (const file of files) {
    const contents = await readTrackedRegularFile(root, file);
    if (contents !== null) findings.push(...scanText(contents, file));
  }
  return findings;
}

export async function validateEnvExamples(root, files) {
  const findings = [];
  for (const file of files.filter((candidate) => path.posix.basename(candidate) === ".env.example")) {
    const contents = await readTrackedRegularFile(root, file);
    if (contents === null) continue;
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const assignment = line.match(envAssignment);
      if (!assignment) {
        findings.push(finding(file, index + 1, "env-example-invalid-line", line));
        continue;
      }
      if (normaliseValue(assignment[2]) !== "") {
        findings.push(finding(file, index + 1, "env-example-nonblank-value", assignment[2]));
      }
    }
  }
  return findings;
}

async function trackedFiles(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean);
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = await trackedFiles(root);
  const findings = [
    ...await scanRepositoryFiles(root, files),
    ...await validateEnvExamples(root, files),
  ];

  if (findings.length === 0) {
    console.log(`Secret scan clean: ${files.length} tracked files scanned.`);
    return;
  }

  for (const item of findings) {
    console.error(`secret finding: ${item.category} ${item.path}:${item.line} ${item.fingerprint}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
