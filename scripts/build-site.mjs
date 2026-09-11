#!/usr/bin/env node
// Assembles the single-domain site: landing at "/" and the dashboard SPA at "/dashboard/".
// Output folder name is configured by LIGOU_SITE_OUTPUT_DIR for the deployment target.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionBuildEnv, validateProductionPublicationEnv } from "./production-env.mjs";
import { publicSiteConfig, publicSiteConfigScript } from "./public-site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function validateOutputDir(outputDir) {
  if (!/^[A-Za-z0-9_-]+$/.test(outputDir)) throw new Error("LIGOU_SITE_OUTPUT_DIR must be a simple directory name");
}

function inspectArtifact(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (/^\.env(?:\.|$)/.test(entry.name) || entry.name === "auth.json" || entry.isSymbolicLink()) {
      throw new Error("private_configuration_or_symlink_in_site_artifact");
    }
    if (entry.isDirectory()) inspectArtifact(path.join(directory, entry.name));
  }
}

// Exported composition supports a small prepared fixture without bypassing the CLI build checks.
export function composeSite({ rootDir = root, outputDir = "client", env = {} } = {}) {
  validateOutputDir(outputDir);
  const config = publicSiteConfig(env);
  const out = path.join(rootDir, "dist", outputDir);
  const buildEnv = productionBuildEnv(env, outputDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const entry of ["index.html", "favicon.svg", "og-card.svg", "og-ligou.png", "assets", "_ds", "comercial", "termos", "privacidade"]) {
    cpSync(path.join(rootDir, entry), path.join(out, entry), { recursive: true });
  }
  cpSync(path.join(rootDir, "dashboard", "dist", "client"), path.join(out, "dashboard"), { recursive: true });
  writeFileSync(path.join(out, "public-config.js"), publicSiteConfigScript(config));
  mkdirSync(path.join(out, "api"), { recursive: true });
  execFileSync("bun", ["build", path.join(rootDir, "src/server/vercel-sales-session.mjs"), "--target=node", "--format=esm", "--outfile", path.join(out, "api/sales-session.mjs")], {
    cwd: rootDir, stdio: "inherit", env: buildEnv,
  });
  writeFileSync(path.join(out, "package.json"), JSON.stringify({ name: "ligou-site", private: true, type: "module", engines: { node: "22.x" } }) + "\n");

  writeFileSync(path.join(out, "vercel.json"), JSON.stringify({
      version: 2, framework: null, buildCommand: null, outputDirectory: null,
      functions: { "api/sales-session.mjs": { maxDuration: 15 } },
      rewrites: [
        { source: "/comercial/", destination: "/comercial/index.html" },
        { source: "/termos/", destination: "/termos/index.html" },
        { source: "/privacidade/", destination: "/privacidade/index.html" },
        { source: "/dashboard/((?!assets/|fonts/|.*\\.).*)", destination: "/dashboard/index.html" },
      ],
      headers: [
        { source: "/public-config.js", headers: [{ key: "Cache-Control", value: "no-store" }] },
        { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
        {
          source: "/dashboard/assets/(.*)",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
      ],
    }, null, 2) + "\n");
  inspectArtifact(out);
  return { out, commercialLoginConfigured: Boolean(config.supabaseUrl && config.supabaseKey) };
}

// Publication is the default: a bundle built without the public voice endpoint
// silently embeds the loopback controller URL (observed in production on
// 2026-09-01 and again as a latent gap on 2026-09-11). Previews opt out explicitly.
export function assertPublicationBuildEnv(buildEnv) {
  for (const name of ["VITE_SUPABASE_URL", "VITE_SESSION_URL"]) {
    if (typeof buildEnv[name] !== "string" || !buildEnv[name].trim()) throw new Error(`production_build_env_incomplete:${name}`);
  }
}

export function buildSite(env = process.env, { publication = true } = {}) {
  if (publication) validateProductionPublicationEnv(env);
  const outputDir = env.LIGOU_SITE_OUTPUT_DIR ?? "client";
  validateOutputDir(outputDir);
  // Validate before invoking either bundler, including the dashboard's public key mapping.
  const config = publicSiteConfig(env);
  const buildEnv = productionBuildEnv({ ...env, LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.supabaseKey || "" }, outputDir);
  if (publication) assertPublicationBuildEnv(buildEnv);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: path.join(root, "src/commercial"), stdio: "inherit", env: buildEnv,
  });
  execFileSync("bun", ["run", "check"], { cwd: root, stdio: "inherit", env: buildEnv });
  execFileSync("npm", ["run", "build"], {
    cwd: path.join(root, "dashboard"), stdio: "inherit",
    // Vite must build with its default base "/dashboard/"; never inherit a stray override.
    env: buildEnv,
  });
  const result = composeSite({ outputDir, env });
  console.log("Site artifact assembled: " + result.out + " (landing, commercial, legal pages and /dashboard/)");
  if (!result.commercialLoginConfigured) console.log("Commercial login unavailable: no public Supabase configuration supplied.");
  console.log("Sales API requires server-only hosting configuration; provider connectivity has not been verified by this build.");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--production', '--preview'].includes(args[0]))) throw new Error('usage: build-site.mjs [--production|--preview]');
  const preview = args[0] === '--preview';
  if (preview) console.log("Preview build: publication env validation skipped (--preview); the bundle may embed the loopback voice endpoint and must not be deployed.");
  buildSite(process.env, { publication: !preview });
}
