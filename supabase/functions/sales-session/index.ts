import { createClient } from "@supabase/supabase-js";
import { createSalesSessionHandler } from "./core.ts";
// Deploy with JWT verification off: Authorization is a random visitor capability,
// never a Supabase user token. Hash comparison and service-only RPCs authorize it.
Deno.serve(createSalesSessionHandler({
  env: (name) => Deno.env.get(name),
  createClient: (url, key) =>
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
}));
