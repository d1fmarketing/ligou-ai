import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "assets", "js");
const sources = [
  { input: "src/claude-v9/ligou-fx2.jsx", output: "ligou-fx2.js" },
  { input: "src/runtime/ligou-app9.jsx", output: "ligou-app9.js" },
];
const transpiler = new Bun.Transpiler({
  loader: "jsx",
  target: "browser",
  tsconfig: { compilerOptions: { jsx: "react" } },
});

await mkdir(outputDirectory, { recursive: true });

for (const { input, output } of sources) {
  const sourcePath = path.join(root, input);
  const source = await readFile(sourcePath, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const banner = [
    "/*",
    ` * Generated from ${input}`,
    ` * Source SHA-256: ${digest}`,
    " * Rebuild with: bun run build",
    " */",
    "",
  ].join("\n");

  await Bun.write(
    path.join(outputDirectory, output),
    banner + transpiler.transformSync(source),
  );
}
