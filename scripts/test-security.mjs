#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = "security-containment";
const env = { ...process.env, LIGOU_SITE_OUTPUT_DIR: outputDir };

// The build must remove this deliberately stale text asset before the recursive proof reads its own tree.
const staleOutput = path.join(root, "dist", outputDir);
mkdirSync(staleOutput, { recursive: true });
writeFileSync(path.join(staleOutput, "stale-containment-proof.txt"), "VITE_TEST_AUTOLOGIN\n");

execFileSync("bun", ["run", "site:build"], { cwd: root, env, stdio: "inherit" });
execFileSync(
  "node",
  ["--test", "tests/security-containment.test.mjs", "tests/secret-scanner.test.mjs"],
  { cwd: root, env, stdio: "inherit" },
);
