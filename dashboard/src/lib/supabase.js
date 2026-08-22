// Supabase browser client — publishable key only (owner-scoped RLS; no secrets in the client).
// PKCE flow keeps tokens out of the URL; the custody storage strips Google provider
// tokens before anything is persisted and confines the PKCE verifier to sessionStorage.
import { createClient } from "@supabase/supabase-js";
import { browserCustodyStorage } from "../auth/session-storage.js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    storage: browserCustodyStorage(),
  },
}) : null;
export const supabaseConfigured = Boolean(supabase);
