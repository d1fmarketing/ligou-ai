#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST_IMAGE = /^[^\s@]+(?:[:][^\s@]+)?@sha256:[a-f0-9]{64}$/;
const CONTAINER = /^ligou-cell-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

export function verifyRunningImageEvidence(container, expected, inspect, repoDigests) {
  if (!CONTAINER.test(container) || !DIGEST_IMAGE.test(expected)) throw new Error("running_image_arguments_invalid");
  if (!inspect || typeof inspect !== "object" || Array.isArray(inspect)
    || inspect.Name !== `/${container}` || inspect.State?.Running !== true
    || inspect.Config?.Image !== expected || !IMAGE_ID.test(inspect.Image)
    || !Array.isArray(repoDigests) || repoDigests.some((value) => typeof value !== "string")
    || !repoDigests.includes(expected)) {
    throw new Error("running_image_mismatch");
  }
  return { ok: true };
}

function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail("running_image_unavailable");
  return result.stdout.trim();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--container" || args[2] !== "--expected") {
    fail("running_image_arguments_invalid");
  }
  const container = args[1];
  const expected = args[3];
  let inspect;
  let repoDigests;
  try {
    inspect = JSON.parse(docker(["inspect", "--format", "{{json .}}", container]));
    repoDigests = JSON.parse(docker(["image", "inspect", "--format", "{{json .RepoDigests}}", inspect.Image ?? ""]));
    verifyRunningImageEvidence(container, expected, inspect, repoDigests);
  } catch (error) {
    fail(error instanceof Error && error.message.startsWith("running_image_") ? error.message : "running_image_mismatch");
  }
  process.stdout.write('{"ok":true}\n');
}
