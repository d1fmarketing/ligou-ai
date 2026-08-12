import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(root, "src", "claude-v9");
const outputDirectory = path.join(root, "assets", "js");
const sources = ["ligou-fx2.jsx", "ligou-app9.jsx"];
const transpiler = new Bun.Transpiler({
  loader: "jsx",
  target: "browser",
  tsconfig: { compilerOptions: { jsx: "react" } },
});

await mkdir(outputDirectory, { recursive: true });

for (const filename of sources) {
  const sourcePath = path.join(sourceDirectory, filename);
  const source = await readFile(sourcePath, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const outputName = filename.replace(/\.jsx$/, ".js");
  const banner = [
    "/*",
    ` * Generated from src/claude-v9/${filename}`,
    ` * Source SHA-256: ${digest}`,
    " * Rebuild with: bun run build",
    " */",
    "",
  ].join("\n");

  await Bun.write(
    path.join(outputDirectory, outputName),
    banner + transpiler.transformSync(source),
  );
}
