/**
 * Every package this package imports has to be a package it declares.
 *
 * The same invariant `clients/mastra-plugin/src/dependencies.test.ts` holds, for the same
 * reason: from inside a working checkout an undeclared import and a declared
 * one resolve identically, so neither the compiler nor any other test here can
 * tell them apart. Only the manifest can. This package sits beside `clients/mastra-plugin/`
 * with its own `node_modules`, which is exactly the arrangement where one
 * hand-made link makes the lanes pass on one machine and nowhere else.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..");

const manifest = JSON.parse(
  readFileSync(join(srcDir, "..", "package.json"), "utf8"),
) as Record<string, Record<string, string> | undefined>;

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

/** Only comments that begin a line are stripped — the whole codebase writes them that way. */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `@mastra/code-sdk/auth/storage` is a subpath of the package `@mastra/code-sdk`. */
function packageRoot(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  return [
    ...code.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm),
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
   * The checks below are about the checker. A walk that matched no files would
   * make the assertion above pass by finding nothing — the exact bug it exists
   * to catch, wearing a green tick.
   */
  it("reads every source file under src", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("recognises the framework packages as imports rather than as prose", () => {
    const found = new Set(sources.flatMap(({ source }) => importedPackages(source)));

    expect(found).toContain("@mastra/core");
    expect(found).toContain("@mastra/code-sdk");
    expect(found).toContain("hono");
  });
});
