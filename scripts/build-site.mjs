#!/usr/bin/env node
// Assembles the single-domain site: landing at "/" and the dashboard SPA at "/dashboard/".
// Output folder name is configured by LIGOU_SITE_OUTPUT_DIR for the deployment target.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionBuildEnv } from "./production-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = process.env.LIGOU_SITE_OUTPUT_DIR ?? "client";
if (!/^[A-Za-z0-9_-]+$/.test(outputDir)) {
  throw new Error("LIGOU_SITE_OUTPUT_DIR must be a simple directory name");
}
const out = path.join(root, "dist", outputDir);
const buildEnv = productionBuildEnv(process.env, outputDir);

execFileSync("bun", ["run", "check"], { cwd: root, stdio: "inherit", env: buildEnv });
execFileSync("npm", ["run", "build"], {
  cwd: path.join(root, "dashboard"),
  stdio: "inherit",
  // Vite must build with its default base "/dashboard/"; never inherit a stray override.
  env: buildEnv,
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const entry of ["index.html", "favicon.svg", "og-card.svg", "og-ligou.png", "assets", "_ds"]) {
  cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
}
cpSync(path.join(root, "dashboard", "dist", "client"), path.join(out, "dashboard"), {
  recursive: true,
});

writeFileSync(
  path.join(out, "vercel.json"),
  JSON.stringify(
    {
      rewrites: [
        { source: "/dashboard/((?!assets/|fonts/|.*\\.).*)", destination: "/dashboard/index.html" },
      ],
      headers: [
        {
          source: "/dashboard/assets/(.*)",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
      ],
    },
    null,
    2,
  ) + "\n",
);

console.log("Site build ready: " + out + " (landing at /, dashboard at /dashboard/)");
