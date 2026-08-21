const PUBLIC_INPUTS = new Map([
  ["LIGOU_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"],
  ["LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"],
  ["LIGOU_PUBLIC_SUPABASE_FUNCTIONS_URL", "VITE_SUPABASE_FUNCTIONS_URL"],
  ["LIGOU_PUBLIC_SESSION_URL", "VITE_SESSION_URL"],
]);

function safeValue(value) {
  return typeof value === "string" && value.length <= 4096 && !/[\r\n\0]/.test(value);
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
