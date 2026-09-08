import { publicSiteConfig } from './public-site-config.mjs';

const PUBLIC_INPUTS = new Map([
  ["LIGOU_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"],
  ["LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"],
  ["LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL", "VITE_SUPABASE_FUNCTIONS_URL"],
  ["LIGOU_PUBLIC_SESSION_URL", "VITE_SESSION_URL"],
]);

function safeValue(value) {
  return typeof value === "string" && value.length <= 4096 && !/[\r\n\0]/.test(value);
}

/** Publication uses the existing Supabase Edge bootstrap. Offline previews do
 * not require credentials; call this only at the explicit release boundary. */
export function validateProductionPublicationEnv(source) {
  for (const name of PUBLIC_INPUTS.keys()) {
    if (typeof source[name] !== 'string' || !source[name].trim()) throw new Error(`production_public_env_required:${name}`);
    if (!safeValue(source[name])) throw new Error('production_public_env_invalid');
  }
  const { supabaseUrl } = publicSiteConfig(source);
  const functionsUrl = `${supabaseUrl}/functions/v1`;
  if (source.LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL !== functionsUrl) throw new Error('production_functions_endpoint_invalid');
  if (source.LIGOU_PUBLIC_SESSION_URL !== `${functionsUrl}/browser-session`) throw new Error('production_voice_endpoint_invalid');
}

export function productionBuildEnv(source, outputDir = "client") {
  if (!/^[A-Za-z0-9_-]+$/.test(outputDir)) throw new Error("production_output_dir_invalid");
  const env = {
    PATH: safeValue(source.PATH) ? source.PATH : "/usr/bin:/bin",
    NODE_ENV: "production",
    LIGOU_BASE: "/dashboard/",
    LIGOU_SITE_OUTPUT_DIR: outputDir,
  };
  for (const name of ["HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (safeValue(source[name])) env[name] = source[name];
  }
  for (const [input, output] of PUBLIC_INPUTS) {
    if (source[input] === undefined || source[input] === "") continue;
    if (!safeValue(source[input])) throw new Error("production_public_env_invalid");
    env[output] = source[input];
  }
  return env;
}
