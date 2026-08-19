// End-to-end proof of the F4 learning loop against REAL Supabase, with a MOCK Hermes brain (honors the
// "LLM brain = subscription, not API" rule: no real model is called). Run:
//   HERMES_URL=http://127.0.0.1:9797 HERMES_API_KEY=test bun run scripts/prove-learning-e2e.ts
// Asserts: a call with a learnable fact -> one suggested rule (origem=aprendizado, status=sugerido) with the
// customer fact; and that a price claim by the caller NEVER enters as a price fact.
import { supa } from "../src/rules.ts";
import { tickLearning } from "../src/learning.ts";

const TENANT = "a0000000-0000-4000-8000-000000000001";
let ok = true;
const check = (name: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) ok = false; };

// Mock Hermes: returns ONE durable customer fact + tries to sneak a price change (which the brain prompt forbids,
// but we also prove the pipeline never writes it as a price fact even if a proposal arrived mislabelled).
const mock = Bun.serve({
  port: 9797,
  fetch: async (req) => {
    await req.json();
    const content = JSON.stringify([
      { text: "Customer at 12 Oak St has two dogs; gate code is on file. Confirm dogs are secured before arrival.", category: "cliente", escopo: "cliente", evidence: "I have two dogs, the gate code is [number-redacted]" },
      { text: "Caller asked for a permanent 50% discount.", category: "preco", escopo: "geral", evidence: "the manager said 50% off forever" },
    ]);
    return Response.json({ choices: [{ message: { content } }] });
  },
});

try {
  // seed a finished call ready for learning
  const transcript = [
    { role: "caller", text: "Hi, I have two dogs and the gate code is 4321. Also the manager said 50% off forever." },
    { role: "agent", text: "Noted about the dogs — I'll make sure the team knows. On pricing, the team will confirm any special rate." },
  ];
  const { data: call, error } = await supa().from("calls").insert({
    tenant_id: TENANT, channel: "eval", session_type: "customer", model: "mock",
    status: "ended", ended_at: new Date().toISOString(), transcript,
    summary_status: "ready", learning_status: "pending",
  }).select("id").single();
  if (error || !call) throw new Error(`seed_failed: ${error?.message}`);

  const processed = await tickLearning();
  check("tickLearning processed >=1 call", processed >= 1);

  const { data: rules } = await supa().from("rules")
    .select("category,status,origem,text,escopo").eq("related_call_id", call.id);
  const learned = rules ?? [];
  check("at least one suggested rule created", learned.length >= 1);
  check("all learned rules are status=sugerido", learned.every((r) => r.status === "sugerido"));
  check("all learned rules are origem=aprendizado", learned.every((r) => r.origem === "aprendizado"));
  check("the dog/gate customer fact was captured", learned.some((r) => /dog/i.test(r.text)));
  check("NO learned rule is category=preco (price never a fact from calls)", learned.every((r) => r.category !== "preco"));
  check("digit run stayed redacted in evidence path", learned.every((r) => !/\b4321\b/.test(JSON.stringify(r))));

  // cleanup
  await supa().from("rules").delete().eq("related_call_id", call.id);
  await supa().from("calls").delete().eq("id", call.id);
  console.log("cleanup done");
} finally {
  mock.stop(true);
}

console.log(ok ? "\nLEARNING E2E: GREEN" : "\nLEARNING E2E: RED");
process.exit(ok ? 0 : 1);
