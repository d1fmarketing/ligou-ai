// Gateways report server failures as { state, warning } instead of throwing
// (same contract in prototype and Supabase modes). Authority actions must wrap
// their calls in requireSuccess: it turns a returned warning into a thrown
// error so perform() shows the warning toast — never a false success.
export async function requireSuccess(promise) {
  const result = await promise;
  if (result?.warning) throw new Error(result.warning);
  return result;
}
