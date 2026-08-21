// Browser Supabase client — publishable key only (owner-scoped RLS; no secrets in the client).
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key, {
  auth: { detectSessionInUrl: true, persistSession: true },
}) : null;
export const supabaseConfigured = Boolean(supabase);
