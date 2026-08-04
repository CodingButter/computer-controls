#!/usr/bin/env node
/**
 * Generate docs/03-tool-api.md from protocol/schema.json.
 *
 * The schema is the source of truth. Hand-editing this doc is a mistake the
 * docs-generation test catches, because regeneration must produce no diff.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "protocol", "schema.json");
const schemaText = readFileSync(schemaPath, "utf8");
const schema = JSON.parse(schemaText);

/** Stamped into the doc so a stale file is visible without diffing. */
const schemaDigest = createHash("sha256").update(schemaText).digest("hex").slice(0, 16);

const sorted = (obj) => Object.keys(obj).sort();

/** Escape a string for a markdown table cell. */
function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Turn a $ref into a markdown link to the shared-types section. */
function refLink(ref) {
  const name = ref.replace("#/$defs/", "");
  return `[\`${name}\`](#${name.toLowerCase()})`;
}

/** Render a JSON Schema node as a compact type string. */
function typeStr(node) {
  if (!node) return "any";
  if (node.$ref) return refLink(node.$ref);
  if (node.enum) return node.enum.map((v) => `\`${cell(v)}\``).join(" \\| ");
  const t = node.type;
  if (Array.isArray(t)) return t.map((x) => typeStr({ ...node, type: x })).join(" \\| ");
  switch (t) {
    case "string": return "string";
    case "integer": return "integer";
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `${typeStr(node.items)}[]`;
    case "object": return "object";
    default: return t || "any";
  }
}

/** Compose requestCommon into a method's params, matching generate-protocol.mjs. */
function composeParams(method) {
  const common = schema.$defs.requestCommon.properties;
  return { ...common, ...(method.params.properties ?? {}) };
}

/** Render a properties table for a JSON Schema object. */
function fieldTable(properties, required) {
  const lines = ["| Field | Type | Required | Description |", "|---|---|---|---|"];
  for (const name of sorted(properties)) {
    const prop = properties[name];
    lines.push(
      `| \`${name}\` | ${typeStr(prop)} | ${required.has(name) ? "yes" : "no"} | ${cell(prop.description)} |`,
    );
  }
  return lines;
}

// Build the document -------------------------------------------------------

const out = [];

out.push("# Tool API");
out.push("");
out.push("Generated from `protocol/schema.json` — do not edit.");
out.push("Run: `node scripts/generate-tool-api-doc.mjs`");
out.push(`Protocol version: ${schema.protocolVersion}   schema sha256: ${schemaDigest}`);
out.push("");
out.push(cell(schema.description));
out.push("");

// Operation classes
out.push("## Operation classes");
out.push("");
out.push(cell(schema.enums.operationClass.description));
out.push("");
out.push("| Class | What it does |");
out.push("|---|---|");
for (const [name, desc] of Object.entries(schema.enums.operationClass.values)) {
  out.push(`| \`${name}\` | ${cell(desc)} |`);
}
out.push("");

// Methods
const methodNames = sorted(schema.methods);
out.push(`## Methods (${methodNames.length})`);
out.push("");

for (const name of methodNames) {
  const method = schema.methods[name];
  out.push(`### \`${name}\``);
  out.push("");
  out.push(`**Operation class:** \`${method.operationClass}\``);
  out.push("");
  out.push(cell(method.summary));
  out.push("");

  // Params
  const composed = composeParams(method);
  const required = new Set(method.params.required ?? []);
  out.push("**Params**");
  out.push("");
  out.push(...fieldTable(composed, required));
  out.push("");

  // anyOf constraints (e.g. queryElements requires at least one filter)
  if (method.params.anyOf) {
    const alts = method.params.anyOf
      .flatMap((branch) => branch.required ?? [])
      .map((f) => `\`${f}\``);
    out.push(`At least one of ${alts.join(", ")} is required.`);
    out.push("");
  }

  // Result
  if (method.result.$ref) {
    out.push(`**Result:** ${refLink(method.result.$ref)}`);
    out.push("");
  } else {
    const resultRequired = new Set(method.result.required ?? []);
    out.push("**Result**");
    out.push("");
    out.push(...fieldTable(method.result.properties ?? {}, resultRequired));
    out.push("");
  }

  out.push("---");
  out.push("");
}

// Shared types
out.push("## Shared types");
out.push("");

for (const name of sorted(schema.$defs)) {
  const def = schema.$defs[name];
  out.push(`### \`${name}\``);
  out.push("");
  if (def.description) {
    out.push(cell(def.description));
    out.push("");
  }
  const props = def.properties ?? {};
  if (Object.keys(props).length > 0) {
    const required = new Set(def.required ?? []);
    out.push(...fieldTable(props, required));
    out.push("");
  }
  out.push("---");
  out.push("");
}

// Enum reference (operationClass already documented above)
out.push("## Enum reference");
out.push("");

for (const enumName of sorted(schema.enums)) {
  if (enumName === "operationClass") continue;
  const enumDef = schema.enums[enumName];
  out.push(`### \`${enumName}\``);
  out.push("");
  out.push(cell(enumDef.description));
  out.push("");
  out.push("| Value | Meaning |");
  out.push("|---|---|");
  for (const [value, desc] of Object.entries(enumDef.values)) {
    out.push(`| \`${value}\` | ${cell(desc)} |`);
  }
  out.push("");
}

// Write
const outPath = join(root, "docs", "03-tool-api.md");
writeFileSync(outPath, out.join("\n") + "\n");
console.log(
  `wrote ${outPath.replace(root + "/", "")} — ${methodNames.length} methods, ` +
    `${Object.keys(schema.$defs).length} shared types, ` +
    `${Object.keys(schema.enums).length} enums, digest ${schemaDigest}`,
);
