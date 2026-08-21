import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SAFE_ARCHIVE_PATH = /^[A-Za-z0-9._/-]+$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail(code) {
  throw new Error(code);
}

function argumentsFor(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) fail("bootstrap_closure_arguments_invalid");
    const key = flag.slice(2);
    if (!new Set(["root", "entry", "commit"]).has(key) || Object.hasOwn(out, key)) fail("bootstrap_closure_arguments_invalid");
    out[key] = value;
  }
  if (!out.root || !out.entry || !out.commit) fail("bootstrap_closure_arguments_missing");
  return out;
}

function decodeEscape(raw, index) {
  const marker = raw[index + 1];
  if (marker === undefined) fail("bootstrap_closure_string_invalid");
  const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
  if (Object.hasOwn(simple, marker)) {
    if (marker === "0" && /[0-9]/.test(raw[index + 2] ?? "")) fail("bootstrap_closure_string_invalid");
    return { value: simple[marker], next: index + 2 };
  }
  if (marker === "\n") return { value: "", next: index + 2 };
  if (marker === "\r") return { value: "", next: raw[index + 2] === "\n" ? index + 3 : index + 2 };
  if (marker === "x") {
    const hex = raw.slice(index + 2, index + 4);
    if (!/^[a-f0-9]{2}$/i.test(hex)) fail("bootstrap_closure_string_invalid");
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 4 };
  }
  if (marker === "u") {
    if (raw[index + 2] === "{") {
      const end = raw.indexOf("}", index + 3);
      const hex = end === -1 ? "" : raw.slice(index + 3, end);
      if (!/^[a-f0-9]{1,6}$/i.test(hex)) fail("bootstrap_closure_string_invalid");
      const point = Number.parseInt(hex, 16);
      if (point > 0x10ffff) fail("bootstrap_closure_string_invalid");
      return { value: String.fromCodePoint(point), next: end + 1 };
    }
    const hex = raw.slice(index + 2, index + 6);
    if (!/^[a-f0-9]{4}$/i.test(hex)) fail("bootstrap_closure_string_invalid");
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 6 };
  }
  return { value: marker, next: index + 2 };
}

function decodeLiteral(raw) {
  let value = "";
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== "\\") {
      value += raw[index];
      index += 1;
      continue;
    }
    const decoded = decodeEscape(raw, index);
    value += decoded.value;
    index = decoded.next;
  }
  return value;
}

function isIdentifierStart(character) {
  return typeof character === "string" && /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character) {
  return typeof character === "string" && /[A-Za-z0-9_$]/.test(character);
}

function regexCanStartAfter(token) {
  if (!token) return true;
  if (token.type === "identifier") {
    return new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await"]).has(token.value);
  }
  return token.type === "punctuator" && new Set([
    "(", "[", "{", ",", ";", ":", "=", "!", "?", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">",
  ]).has(token.value);
}

function tokenize(source) {
  const tokens = [];
  let index = 0;

  const readQuoted = (quote) => {
    index += 1;
    let raw = "";
    while (index < source.length) {
      const character = source[index];
      if (character === quote) {
        index += 1;
        return { type: "string", value: decodeLiteral(raw) };
      }
      if (character === "\n" || character === "\r") fail("bootstrap_closure_string_invalid");
      if (character === "\\") {
        const start = index;
        const decoded = decodeEscape(source, index);
        raw += source.slice(start, decoded.next);
        index = decoded.next;
        continue;
      }
      raw += character;
      index += 1;
    }
    fail("bootstrap_closure_string_invalid");
  };

  const readRegex = () => {
    index += 1;
    let escaped = false;
    let characterClass = false;
    while (index < source.length) {
      const character = source[index];
      if (character === "\n" || character === "\r") fail("bootstrap_closure_regex_invalid");
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "[") characterClass = true;
      else if (character === "]") characterClass = false;
      else if (character === "/" && !characterClass) {
        index += 1;
        while (/[A-Za-z]/.test(source[index] ?? "")) index += 1;
        tokens.push({ type: "other", value: "regex" });
        return;
      }
      index += 1;
    }
    fail("bootstrap_closure_regex_invalid");
  };

  const scanCode = (stopAtTemplateBrace = false) => {
    let braces = 0;
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) { index += 1; continue; }
      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end === -1) fail("bootstrap_closure_comment_invalid");
        index = end + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        tokens.push(readQuoted(character));
        continue;
      }
      if (character === "`") {
        index += 1;
        const template = { type: "template", value: "", interpolated: false };
        tokens.push(template);
        let raw = "";
        while (index < source.length) {
          const next = source[index];
          if (next === "`") {
            index += 1;
            if (!template.interpolated) template.value = decodeLiteral(raw);
            break;
          }
          if (next === "\\") {
            const start = index;
            const decoded = decodeEscape(source, index);
            raw += source.slice(start, decoded.next);
            index = decoded.next;
            continue;
          }
          if (next === "$" && source[index + 1] === "{") {
            template.interpolated = true;
            index += 2;
            scanCode(true);
            continue;
          }
          raw += next;
          index += 1;
        }
        if (index > source.length || source[index - 1] !== "`") fail("bootstrap_closure_template_invalid");
        continue;
      }
      if (isIdentifierStart(character)) {
        const start = index;
        index += 1;
        while (isIdentifierPart(source[index])) index += 1;
        tokens.push({ type: "identifier", value: source.slice(start, index) });
        continue;
      }
      if (character === "/" && regexCanStartAfter(tokens.at(-1))) {
        readRegex();
        continue;
      }
      if (character === "{") {
        braces += 1;
        tokens.push({ type: "punctuator", value: character });
        index += 1;
        continue;
      }
      if (character === "}" && stopAtTemplateBrace) {
        if (braces === 0) { index += 1; return; }
        braces -= 1;
        tokens.push({ type: "punctuator", value: character });
        index += 1;
        continue;
      }
      tokens.push({ type: "punctuator", value: character });
      index += 1;
    }
    if (stopAtTemplateBrace) fail("bootstrap_closure_template_invalid");
  };

  scanCode(false);
  return tokens;
}

function literalSpecifier(token) {
  if (token?.type === "string") return token.value;
  if (token?.type === "template" && token.interpolated === false) return token.value;
  return null;
}

function staticFromSpecifier(tokens, start) {
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]?.value;
    if (value === ";" && Object.values(depth).every((part) => part === 0)) return { found: false, value: null };
    if (Object.hasOwn(depth, value)) { depth[value] += 1; continue; }
    if (Object.hasOwn(closing, value)) {
      const opener = closing[value];
      depth[opener] = Math.max(0, depth[opener] - 1);
      continue;
    }
    if (Object.values(depth).every((part) => part === 0)
      && tokens[cursor]?.type === "identifier" && value === "from") {
      return { found: true, value: literalSpecifier(tokens[cursor + 1]) };
    }
  }
  return { found: false, value: null };
}

function isImportIdentifierName(tokens, index) {
  const next = tokens[index + 1]?.value;
  if (next === ":") return true;
  if (next !== "(") return false;
  let depth = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor]?.value;
    if (value === "(") depth += 1;
    else if (value === ")") {
      depth -= 1;
      if (depth === 0) return tokens[cursor + 1]?.value === "{";
    }
  }
  return false;
}

export function moduleSpecifiers(source) {
  const tokens = tokenize(source);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (token.value === "import") {
      if (tokens[index - 1]?.value === "." || tokens[index + 1]?.value === ".") continue;
      if (isImportIdentifierName(tokens, index)) continue;
      if (tokens[index + 1]?.value === "(") {
        const argument = tokens[index + 2];
        const specifier = literalSpecifier(argument);
        if (specifier === null) fail("bootstrap_closure_dynamic_import_nonliteral");
        if (!new Set([")", ","]).has(tokens[index + 3]?.value)) fail("bootstrap_closure_dynamic_import_nonliteral");
        specifiers.push(specifier);
        continue;
      }
      const direct = literalSpecifier(tokens[index + 1]);
      if (direct !== null) {
        specifiers.push(direct);
        continue;
      }
      const found = staticFromSpecifier(tokens, index + 1);
      if (!found.found || found.value === null) fail("bootstrap_closure_static_import_invalid");
      specifiers.push(found.value);
      continue;
    }
    if (token.value === "export") {
      if (!new Set(["*", "{"]).has(tokens[index + 1]?.value)) continue;
      const found = staticFromSpecifier(tokens, index + 1);
      if (found.found && found.value === null) fail("bootstrap_closure_static_import_invalid");
      if (found.value !== null) specifiers.push(found.value);
    }
  }
  return specifiers;
}

function containedRelativePath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("bootstrap_closure_import_escape");
  }
  const archivePath = relative.split(path.sep).join("/");
  if (!SAFE_ARCHIVE_PATH.test(archivePath)) fail("bootstrap_closure_path_unsafe");
  return archivePath;
}

function filesystemReader(root) {
  return (archivePath) => {
    const current = path.resolve(root, archivePath);
    containedRelativePath(root, current);
    let stat;
    try { stat = lstatSync(current); }
    catch { fail("bootstrap_closure_module_missing"); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail("bootstrap_closure_module_invalid");
    containedRelativePath(root, realpathSync(current));
    return readFileSync(current, "utf8");
  };
}

function committedReader(root, commit) {
  if (!COMMIT.test(commit)) fail("bootstrap_closure_commit_invalid");
  const resolved = spawnSync("git", ["-C", root, "rev-parse", `${commit}^{commit}`], { encoding: "utf8" });
  if (resolved.status !== 0 || resolved.stdout.trim() !== commit) fail("bootstrap_closure_commit_unavailable");
  return (archivePath) => {
    const listed = spawnSync("git", ["-C", root, "ls-tree", "-z", commit, "--", archivePath], {
      encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    if (listed.status !== 0) fail("bootstrap_closure_commit_unavailable");
    const records = listed.stdout.split("\0").filter(Boolean);
    if (records.length !== 1) fail("bootstrap_closure_module_missing");
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(records[0]);
    if (!match || match[3] !== archivePath) fail("bootstrap_closure_module_invalid");
    const content = spawnSync("git", ["-C", root, "cat-file", "blob", match[2]], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    if (content.status !== 0) fail("bootstrap_closure_module_missing");
    return content.stdout;
  };
}

export function localModuleClosure(rootInput, entryInput, options = {}) {
  const root = realpathSync(path.resolve(rootInput));
  if (path.isAbsolute(entryInput) || entryInput.includes("\\")) fail("bootstrap_closure_entry_invalid");
  const entry = containedRelativePath(root, path.resolve(root, entryInput));
  const readModule = options.commit ? committedReader(root, options.commit) : filesystemReader(root);
  const pending = [entry];
  const included = new Set();

  while (pending.length) {
    const current = pending.pop();
    if (included.has(current)) continue;
    const source = readModule(current);
    included.add(current);
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.includes("\\") || specifier.includes("?") || specifier.includes("#")) {
        fail("bootstrap_closure_import_invalid");
      }
      if (specifier.startsWith(".")) {
        pending.push(containedRelativePath(root, path.resolve(root, path.posix.dirname(current), specifier)));
      } else if (!specifier.startsWith("node:")) {
        fail("bootstrap_closure_external_import_forbidden");
      }
    }
  }
  return [...included].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = argumentsFor(process.argv.slice(2));
    process.stdout.write(localModuleClosure(args.root, args.entry, { commit: args.commit }).join(" ") + "\n");
  } catch (error) {
    process.stderr.write(`${error?.message ?? "bootstrap_closure_failed"}\n`);
    process.exit(1);
  }
}
