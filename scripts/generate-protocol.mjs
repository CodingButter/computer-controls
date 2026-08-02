#!/usr/bin/env node
/**
 * Generate both halves' protocol bindings from protocol/schema.json.
 *
 * The schema is the source of truth. Hand-editing either generated file is a
 * mistake the generator test catches, because regeneration must produce no diff.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "protocol", "schema.json");
const schemaText = readFileSync(schemaPath, "utf8");
const schema = JSON.parse(schemaText);

/** Stamped into both files so a stale binding is visible without diffing. */
const schemaDigest = createHash("sha256").update(schemaText).digest("hex").slice(0, 16);

const banner = (comment) =>
  [
    `${comment} Generated from protocol/schema.json — do not edit.`,
    `${comment} Run: node scripts/generate-protocol.mjs`,
    `${comment} Protocol version: ${schema.protocolVersion}   schema sha256: ${schemaDigest}`,
  ].join("\n");

const quote = (value) => JSON.stringify(value);

/** Sorted so output never depends on key insertion order. */
const sorted = (object) => Object.keys(object).sort();

/**
 * Compose `requestCommon` into every method's params.
 *
 * `confirm` and `clientId` apply to every call, and both halves must see them on
 * every method or segment 3 would have to add a field to a frozen protocol. This
 * is done here rather than by `allOf` in the schema because `allOf` combined with
 * `additionalProperties: false` rejects the very fields it is meant to add — the
 * parent object cannot see into the branch. Composing eagerly keeps one obvious
 * meaning instead of a correct-but-surprising one.
 */
function composeParams(method) {
  const common = schema.$defs.requestCommon.properties;
  return {
    ...method.params,
    properties: { ...common, ...(method.params.properties ?? {}) },
  };
}

// ---------------------------------------------------------------- TypeScript

/** JSON Schema type -> TypeScript type. Recursive, and deliberately narrow: it
 *  handles the constructs this schema actually uses and throws on anything else
 *  rather than silently emitting `any`. */
function tsType(node, indent = "  ") {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  if (node.enum) return node.enum.map(quote).join(" | ");
  if (Array.isArray(node.type)) {
    return node.type.map((t) => tsType({ ...node, type: t }, indent)).join(" | ");
  }
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${tsType(node.items, indent)}[]`;
    case "object":
      return tsObject(node, indent);
    default:
      throw new Error(`unhandled schema node: ${JSON.stringify(node).slice(0, 120)}`);
  }
}

function tsObject(node, indent) {
  const properties = node.properties ?? {};
  const names = sorted(properties);
  if (names.length === 0) {
    return node.additionalProperties ? "Record<string, unknown>" : "Record<string, never>";
  }
  const required = new Set(node.required ?? []);
  const inner = indent + "  ";
  const lines = names.map((name) => {
    const property = properties[name];
    const optional = required.has(name) ? "" : "?";
    const doc = property.description ? `${inner}/** ${property.description} */\n` : "";
    return `${doc}${inner}${name}${optional}: ${tsType(property, inner)};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function generateTypeScript() {
  const out = [banner("//"), ""];
  out.push(`export const PROTOCOL_VERSION = ${quote(schema.protocolVersion)} as const;`);
  out.push(`export const SCHEMA_DIGEST = ${quote(schemaDigest)} as const;`, "");

  for (const [name, values] of Object.entries(schema.enums)) {
    const typeName = name.charAt(0).toUpperCase() + name.slice(1);
    const members = Object.keys(values.values);
    out.push(`/** ${values.description} */`);
    out.push(`export type ${typeName} = ${members.map(quote).join(" | ")};`);
    out.push(
      `export const ${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_VALUES: readonly ${typeName}[] = [${members
        .map(quote)
        .join(", ")}];`,
      "",
    );
  }

  for (const name of sorted(schema.$defs)) {
    const def = schema.$defs[name];
    const typeName = name.charAt(0).toUpperCase() + name.slice(1);
    if (def.description) out.push(`/** ${def.description} */`);
    out.push(`export interface ${typeName} ${tsObject(def, "")}`, "");
  }

  out.push("/** Every method, its operation class, and its request and response shapes. */");
  for (const name of sorted(schema.methods)) {
    const method = schema.methods[name];
    const base = name.charAt(0).toUpperCase() + name.slice(1);
    out.push(`/** ${method.summary} (operation class: ${method.operationClass}) */`);
    out.push(`export interface ${base}Params ${tsObject(composeParams(method), "")}`);
    out.push(`export interface ${base}Result ${tsObject(method.result, "")}`, "");
  }

  const names = sorted(schema.methods);
  out.push(`export type MethodName = ${names.map(quote).join(" | ")};`, "");
  out.push("export const OPERATION_CLASS: Record<MethodName, OperationClass> = {");
  for (const name of names) {
    out.push(`  ${name}: ${quote(schema.methods[name].operationClass)},`);
  }
  out.push("};", "");

  out.push("export interface MethodMap {");
  for (const name of names) {
    const base = name.charAt(0).toUpperCase() + name.slice(1);
    out.push(`  ${name}: { params: ${base}Params; result: ${base}Result };`);
  }
  out.push("}", "");

  return out.join("\n");
}

// --------------------------------------------------------------- Zod runtime

/**
 * The plugin needs runtime schemas as well as types, because tool input and
 * output schemas are values. Generating them keeps a tool's declared shape and
 * the protocol from drifting — which they had already started to do by hand.
 */
function zodType(node, indent) {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    return `${name}Schema`;
  }
  if (node.enum) return `z.enum([${node.enum.map(quote).join(", ")}])`;
  if (Array.isArray(node.type)) {
    const parts = node.type.map((t) => zodType({ ...node, type: t }, indent));
    return `z.union([${parts.join(", ")}])`;
  }
  switch (node.type) {
    case "string":
      return `z.string()${node.pattern ? `.regex(${new RegExp(node.pattern)})` : ""}`;
    case "integer":
      return `z.number().int()${bounds(node)}`;
    case "number":
      return `z.number()${bounds(node)}`;
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return `z.array(${zodType(node.items, indent)})`;
    case "object":
      return zodObject(node, indent);
    default:
      throw new Error(`unhandled node in zod generation: ${JSON.stringify(node).slice(0, 100)}`);
  }
}

/** Numeric constraints. Dropping these silently was a real bug: the schema said
 *  depth maxes at 12 and the generated validator accepted 99. */
function bounds(node) {
  let out = "";
  if (node.minimum !== undefined) out += `.min(${node.minimum})`;
  if (node.maximum !== undefined) out += `.max(${node.maximum})`;
  return out;
}

function zodObject(node, indent) {
  const properties = node.properties ?? {};
  const names = sorted(properties);
  if (names.length === 0) return "z.record(z.string(), z.unknown())";
  const required = new Set(node.required ?? []);
  const inner = indent + "  ";
  const lines = names.map((name) => {
    const property = properties[name];
    let expression = zodType(property, inner);
    if (property.description) {
      expression += `.describe(${quote(property.description)})`;
    }
    if (!required.has(name)) expression += ".optional()";
    return `${inner}${name}: ${expression},`;
  });
  return `z.object({\n${lines.join("\n")}\n${indent}})`;
}

function generateZod() {
  const out = [banner("//"), "", 'import { z } from "mastracode/plugin";', ""];

  // Order matters: a schema referenced by another must be declared first, since
  // these are plain const initialisers. The one exception is the recursive
  // definition, which refers to itself and is therefore wrapped in `z.lazy` —
  // that defers evaluation, which is exactly what makes the self-reference legal.
  const isRecursive = (name) =>
    JSON.stringify(schema.$defs[name]).includes(`#/$defs/${name}`);
  // requestCommon and responseCommon are composed into methods, not emitted.
  const emitted = sorted(schema.$defs).filter(
    (name) => name !== "requestCommon" && name !== "responseCommon",
  );

  for (const name of emitted) {
    if (isRecursive(name)) continue;
    out.push(`export const ${name}Schema = ${zodObject(schema.$defs[name], "")};`, "");
  }
  for (const name of emitted) {
    if (!isRecursive(name)) continue;
    out.push(
      `export const ${name}Schema: z.ZodType<unknown> = z.lazy(() =>`,
      `  ${zodObject(schema.$defs[name], "  ")},`,
      ");",
      "",
    );
  }

  for (const name of sorted(schema.methods)) {
    const method = schema.methods[name];
    const params = composeParams(method);
    // `anyOf` becomes a refinement so the *plugin* refuses an under-specified
    // request rather than letting the model spend a round trip discovering that
    // the service refuses it. Same rule, enforced one layer earlier.
    let expression = zodObject(params, "");
    if (params.anyOf) {
      const alternatives = params.anyOf.flatMap((branch) => branch.required ?? []);
      expression +=
        `.refine((value) => ${alternatives
          .map((field) => `value.${field} !== undefined`)
          .join(" || ")}, { message: ${quote(
          `at least one of ${alternatives.join(", ")} is required`,
        )} })`;
    }
    out.push(`export const ${name}Params = ${expression};`);
    out.push(`export const ${name}Result = ${zodObject(method.result, "")};`, "");
  }

  return out.join("\n");
}

// -------------------------------------------------------------------- Python

/**
 * The Python side gets the schema itself plus a small validator, rather than
 * dataclasses. The service's job at the boundary is to *reject* a malformed
 * request with INVALID_PARAMS, which is a validation problem, not a typing one.
 */
function generatePython() {
  const out = [
    '"""Protocol bindings for the desktop service."""',
    "",
    banner("#"),
    "",
    "from __future__ import annotations",
    "",
    "from typing import Any, Final",
    "",
    `PROTOCOL_VERSION: Final = ${quote(schema.protocolVersion)}`,
    `SCHEMA_DIGEST: Final = ${quote(schemaDigest)}`,
    "",
  ];

  for (const [name, values] of Object.entries(schema.enums)) {
    const singular = name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    // "operationClass" pluralises to OPERATION_CLASSES, not OPERATION_CLASSS.
    const constant = singular.endsWith("S") ? `${singular}ES` : `${singular}S`;
    out.push(`#: ${values.description}`);
    out.push(
      `${constant}: Final[tuple[str, ...]] = (${Object.keys(values.values)
        .map(quote)
        .join(", ")})`,
      "",
    );
  }

  const names = sorted(schema.methods);
  out.push("#: Every method mapped to the operation class it belongs to.");
  out.push("OPERATION_CLASS: Final[dict[str, str]] = {");
  for (const name of names) {
    out.push(`    ${quote(name)}: ${quote(schema.methods[name].operationClass)},`);
  }
  out.push("}", "");

  out.push("#: Request schema per method, used to reject malformed calls at the boundary.");
  out.push(`PARAMS_SCHEMA: Final[dict[str, dict[str, Any]]] = ${pyLiteral(
    Object.fromEntries(names.map((n) => [n, composeParams(schema.methods[n])])),
    "",
  )}`);
  out.push("");
  out.push(`RESULT_SCHEMA: Final[dict[str, dict[str, Any]]] = ${pyLiteral(
    Object.fromEntries(names.map((n) => [n, schema.methods[n].result])),
    "",
  )}`);
  out.push("");
  out.push(`DEFS: Final[dict[str, dict[str, Any]]] = ${pyLiteral(schema.$defs, "")}`);
  out.push("");

  return out.join("\n");
}

/** JSON -> Python literal. Deterministic key order, so regeneration is stable. */
function pyLiteral(value, indent) {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  const inner = indent + "    ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${inner}${pyLiteral(v, inner)},`);
    return `[\n${items.join("\n")}\n${indent}]`;
  }
  const keys = sorted(value);
  if (keys.length === 0) return "{}";
  const entries = keys.map((k) => `${inner}${quote(k)}: ${pyLiteral(value[k], inner)},`);
  return `{\n${entries.join("\n")}\n${indent}}`;
}

writeFileSync(join(root, "plugin", "src", "protocol.generated.ts"), generateTypeScript());
writeFileSync(join(root, "plugin", "src", "schemas.generated.ts"), generateZod());
writeFileSync(
  join(root, "service", "desktop_service", "protocol_generated.py"),
  generatePython(),
);

