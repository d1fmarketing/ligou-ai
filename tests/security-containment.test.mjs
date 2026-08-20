import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("production site excludes the retired fragment/password auto-login path", async () => {
  const siteRoot = new URL("../dist/client/", import.meta.url);
  const landing = await readFile(new URL("index.html", siteRoot), "utf8");
  const assets = await readdir(new URL("dashboard/assets/", siteRoot));
  const bundles = await Promise.all(
    assets
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(new URL(`dashboard/assets/${name}`, siteRoot), "utf8")),
  );
  const productionOutput = `${landing}\n${bundles.join("\n")}`;

  assert.doesNotMatch(productionOutput, /VITE_TEST_AUTOLOGIN/);
  assert.doesNotMatch(productionOutput, /signInWithPassword/);
  assert.doesNotMatch(productionOutput, /ligou\.test\.k/);
  assert.doesNotMatch(productionOutput, /#k=/);
  assert.match(productionOutput, /signInWithOtp/);
});
