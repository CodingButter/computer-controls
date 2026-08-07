/**
 * Every package this plugin imports has to be a package this plugin declares.
 *
 * The lanes were once unrunnable from a fresh clone because they were not: two
 * framework packages resolved through a symlink someone had made by hand into
 * `node_modules`, so they worked perfectly on the one machine that had it and
 * on no other. That failure is invisible to the compiler and to every other
 * test here, because from inside a working checkout an undeclared import and a
 * declared one resolve identically. Only the manifest can tell them apart.
 *
 * So the assertion is about the manifest, not about resolution. Checking that
 * a specifier resolves would prove nothing — a hand-made symlink is exactly a
 * thing that resolves.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = import.meta.dirname;

const manifest = JSON.parse(
  readFileSync(join(srcDir, "..", "package.json"), "utf8"),
) as Record<string, Record<string, string> | undefined>;

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

/**
 * Comments in this codebase discuss module specifiers in prose, and a header
 * that names a package it no longer imports would otherwise read as an import.
 *
 * Only comments that begin a line are stripped, which is how every comment in
 * this codebase is written. Stripping from any `/*` would let one appearing
 * inside a future string literal swallow the rest of the file — and a checker
 * that silently stops looking is worse than no checker.
 */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `@mastra/core/processors` is a subpath of the package `@mastra/core`. */
function packageRoot(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  return [
    // A static import or re-export. The clause may wrap across lines, so the
    // match spans them — but it may not span a quote or a semicolon, which is
    // what keeps it from running out of one statement and into a later string
    // that happens to contain the word `from`.
    ...code.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm),
    // A side-effect import: `import "./polyfill.ts"`.
    ...code.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm),
    ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
}

function importedPackages(source: string): string[] {
  return importSpecifiers(source)
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
    .map(packageRoot);
}

const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => ({ file: entry, source: readFileSync(join(srcDir, entry), "utf8") }));

describe("declared dependencies", () => {
  it("declares every package imported anywhere under src", () => {
    const undeclared = sources.flatMap(({ file, source }) =>
      importedPackages(source)
        .filter((name) => !declared.has(name))
        .map((name) => `${file} imports ${name}`),
    );

    expect(undeclared).toEqual([]);
  });

  /**
   * The checks below are about the checker. A source walk that matched no files,
   * or an extractor that stopped recognising imports, would make the assertion
   * above pass by finding nothing — the exact shape of the bug it exists to
   * catch, wearing a green tick.
   */
  it("reads every source file under src", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("finds a specifier in every file that has an import statement", () => {
    // Not every file imports something — a self-contained class or a generated
    // table of constants need not. But a file whose text plainly begins a line
    // with `import` and from which this extractor recovers nothing is the
    // silent failure: the regexes stopped matching and nothing said so.
    const silent = sources
      .filter(({ source }) => /^import\b/m.test(source))
      .filter(({ source }) => importSpecifiers(source).length === 0)
      .map(({ file }) => file);

    expect(silent).toEqual([]);
  });

  it("recognises the framework packages as imports rather than as prose", () => {
    const found = new Set(sources.flatMap(({ source }) => importedPackages(source)));

    expect(found).toContain("@mastra/core");
    expect(found).toContain("@mastra/code-sdk");
  });
});
