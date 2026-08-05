// The live module's browser delivery, regenerated: tsc (the one already in
// devDependencies — no bundler exists in this repo and none may be added)
// compiles src/live/*.ts to plain multi-file ESM under public/live/, and
// `rewriteRelativeImportExtensions` in tsconfig.live.json turns the source's
// `./x.ts` specifiers into `./x.js`, so a browser resolves the cluster
// natively. The emitted files are committed; asset-parity.test.ts regenerates
// and diffs, so the page and the hub can never quietly run different
// protocols.
//
// Usage: node scripts/generate-live-assets.mjs [outDir]
// The optional outDir exists for the parity test, which regenerates into a
// temp directory and compares instead of overwriting the committed files.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ?? path.join(clientRoot, "public", "live");

execFileSync(
  "pnpm",
  ["exec", "tsc", "-p", "tsconfig.live.json", "--outDir", outDir],
  { cwd: clientRoot, stdio: "inherit" },
);

// Belt and braces: an extensionless relative specifier in the output is a
// module a browser cannot load, whatever the compiler options claimed.
const bad = [];
for (const name of readdirSync(outDir).filter((n) => n.endsWith(".js"))) {
  const text = readFileSync(path.join(outDir, name), "utf8");
  for (const match of text.matchAll(/^(?:import|export)[^\n]*from\s+["'](\.[^"']*)["']/gm)) {
    if (!match[1].endsWith(".js")) bad.push(`${name}: ${match[1]}`);
  }
}
if (bad.length > 0) {
  console.error("Relative specifiers a browser cannot resolve:\n" + bad.join("\n"));
  process.exit(1);
}
console.log(`live assets emitted to ${outDir}`);
