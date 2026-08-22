// One-button Google sign-in via Supabase Auth (PKCE). Identity plus the narrow
// Calendar scopes; offline access so a consent grant returns a reusable
// refresh token for the connector. prompt=consent only when explicitly needed.
import { dashboardRedirectUrl } from "../runtime-config.js";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

export async function signInWithGoogle(client, { origin, baseUrl, withConsent = false }) {
  const queryParams = { access_type: "offline" };
  if (withConsent) queryParams.prompt = "consent";
  return client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: dashboardRedirectUrl(origin, baseUrl),
      scopes: GOOGLE_SCOPES,
      queryParams,
    },
  });
}
