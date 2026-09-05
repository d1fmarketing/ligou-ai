// Public configuration only. Never accept a secret/service-role key into a browser artifact.
export function publicSiteConfig(env = {}) {
  const supabaseUrl = env.LIGOU_PUBLIC_SUPABASE_URL || "";
  const primaryKey = env.LIGOU_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  const previewKey = env.LIGOU_PUBLIC_SUPABASE_KEY || "";
  if (primaryKey && previewKey && primaryKey !== previewKey) throw new Error("public_supabase_key_conflict");
  const supabaseKey = primaryKey || previewKey;
  if (!supabaseUrl && !supabaseKey) return {};
  if (!supabaseUrl || !supabaseKey) throw new Error("public_supabase_config_incomplete");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) throw new Error("public_supabase_url_invalid");
  let isPublic = /^sb_publishable_[A-Za-z0-9_-]+$/.test(supabaseKey);
  if (!isPublic && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(supabaseKey)) {
    try {
      isPublic = JSON.parse(Buffer.from(supabaseKey.split(".")[1], "base64url").toString()).role === "anon";
    } catch {}
  }
  if (!isPublic || supabaseKey.length > 4096) throw new Error("public_supabase_key_invalid");
  return { supabaseUrl, supabaseKey };
}

export function publicSiteConfigScript(config) {
  return `window.LIGOU_PUBLIC_CONFIG=Object.freeze(${JSON.stringify(config)});\n`;
}
