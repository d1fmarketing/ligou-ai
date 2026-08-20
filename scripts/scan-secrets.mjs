#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const placeholder = /^(?:|change-me|example|placeholder|replace-me|your[-_].*|\$\{[^}]+\}|<[^>]+>)$/i;
const namedAssignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:API_)?(?:KEY|SECRET|TOKEN|PASSWORD))\s*=\s*(.*?)\s*(?:#.*)?$/;
const tokenPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
];

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function normaliseValue(raw) {
  return raw.trim().replace(/^['"]|['"]$/g, "");
}

export function scanText(text, filePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const assignment = line.match(namedAssignment);
    if (assignment) {
      const value = normaliseValue(assignment[2]);
      if (!placeholder.test(value)) {
        findings.push({
          path: filePath,
          line: index + 1,
          category: "named-secret-assignment",
          fingerprint: fingerprint(value),
        });
      }
    }

    for (const pattern of tokenPatterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        findings.push({
          path: filePath,
          line: index + 1,
          category: "credential-shaped-token",
          fingerprint: fingerprint(match[0]),
        });
      }
    }
  }

  return findings;
}

export async function scanRepositoryFiles(root, files) {
  const findings = [];
  for (const file of files) {
    const contents = await readFile(path.join(root, file));
    if (contents.includes(0)) continue;
    findings.push(...scanText(contents.toString("utf8"), file));
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
  const findings = await scanRepositoryFiles(root, files);

  if (findings.length === 0) {
    console.log(`Secret scan clean: ${files.length} tracked files scanned.`);
    return;
  }

  for (const finding of findings) {
    console.error(`secret finding: ${finding.category} ${finding.path}:${finding.line} ${finding.fingerprint}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
