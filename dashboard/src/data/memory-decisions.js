// Batch approval for interview suggestions: the ONLY path that turns a
// 'sugerido' rule into effective policy is the server's decide_rule RPC
// (owner-gated, append-only versioning, epoch bump on approval).
const DECISIONS = new Set(["aprovado", "rejeitado"]);

export async function decideMemoryVia(client, ruleId, decision) {
  if (!DECISIONS.has(decision)) throw new Error(`decision_invalid: ${decision}`);
  const { data, error } = await client.rpc("decide_rule", { p_rule: ruleId, p_decision: decision });
  if (error) throw new Error(error.message);
  return data;
}
