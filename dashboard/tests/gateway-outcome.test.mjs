// False-success guard: the Supabase gateway reports server failures as
// { state, warning } instead of throwing (uniform contract with the prototype
// gateway). Authority call sites in App.jsx route every action through
// requireSuccess so a returned warning lands in perform()'s catch — the
// warning toast — and can never be announced as success.
import { test } from "node:test";
import assert from "node:assert/strict";

import { requireSuccess } from "../src/data/gateway-outcome.js";

test("a gateway result carrying a warning rejects with the server message (warning toast path)", async () => {
  await assert.rejects(
    () => requireSuccess(Promise.resolve({ state: { revision: 1 }, warning: "case_not_pending" })),
    /case_not_pending/,
  );
});

test("a clean gateway result resolves untouched (success toast path)", async () => {
  const result = await requireSuccess(Promise.resolve({ state: { revision: 2 }, approval: { id: "a1" } }));
  assert.deepEqual(result, { state: { revision: 2 }, approval: { id: "a1" } });
});

test("a gateway that throws keeps throwing — requireSuccess never swallows errors", async () => {
  await assert.rejects(() => requireSuccess(Promise.reject(new Error("network_down"))), /network_down/);
});

test("an action that resolves without a body still counts as success", async () => {
  assert.equal(await requireSuccess(Promise.resolve(undefined)), undefined);
});
