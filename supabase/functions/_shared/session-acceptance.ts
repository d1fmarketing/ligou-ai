// Temporary schema-dual rollback bridge. This release is based on the last live
// pre-onboarding-v2 commit and must never accept an onboarding session that can
// write the legacy shape after the database advances.
export const ONBOARDING_ACCEPTANCE = "disabled_rollback_bridge" as const;
export const ROLLBACK_BRIDGE_BASE = "6f65667b428fa0f3f7e3df31534746e120553b10" as const;
export const ONBOARDING_DISABLED_ERROR = "onboarding_disabled_rollback_bridge" as const;

export function assertSessionTypeAccepted(sessionType: unknown): void {
  if (sessionType !== "onboarding") return;
  throw Object.assign(new Error(ONBOARDING_DISABLED_ERROR), { status: 503 });
}
