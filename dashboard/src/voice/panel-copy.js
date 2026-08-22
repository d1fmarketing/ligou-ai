// Session-type copy for the voice dialog. The onboarding interview runs in
// Portuguese; owner role-play stays EN/ES because the agent serves callers in
// those languages.
export function statusLineFor(sessionType) {
  if (sessionType === "onboarding") return "Ao vivo — entrevista em português";
  return "Ao vivo — fale em inglês ou espanhol";
}

export function defaultSessionType(tenantStatus) {
  return tenantStatus === "onboarding" ? "onboarding" : "owner_browser";
}

export function onboardingCta(tenantStatus) {
  if (tenantStatus !== "onboarding") return null;
  return "Começar a entrevista de onboarding (voz)";
}
