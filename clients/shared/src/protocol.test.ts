import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OPERATION_CLASS,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  type InspectWindowParams,
  type MethodName,
  type QueryElementsParams,
  type SemanticElement,
} from "./protocol.generated.ts";

const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol", "schema.json"), "utf8"),
);

describe("generated protocol bindings", () => {
  it("carries the schema's version and a digest of the schema it came from", () => {
    expect(PROTOCOL_VERSION).toBe(schema.protocolVersion);
    expect(SCHEMA_DIGEST).toHaveLength(16);
  });

  it("declares every method the schema declares, and no others", () => {
    expect(Object.keys(OPERATION_CLASS).sort()).toEqual(Object.keys(schema.methods).sort());
  });

  it("agrees with the schema on every operation class", () => {
    for (const [name, spec] of Object.entries<any>(schema.methods)) {
      expect(OPERATION_CLASS[name as MethodName]).toBe(spec.operationClass);
    }
  });

  it("gives every method the common request fields", () => {
    // `confirm` has to exist on every method now, or segment 3 would have to add
    // a required field to a frozen protocol to enforce confirmation.
    const params: QueryElementsParams = {
      windowId: "win-000000000000",
      role: "push button",
      confirm: true,
      clientId: "test",
    };
    expect(params.confirm).toBe(true);
  });

  it("types a semantic element recursively", () => {
    const element: SemanticElement = {
      id: "el-000000000001",
      backend: "atspi",
      role: "frame",
      name: "Text Editor",
      states: ["showing"],
      actions: ["page.save"],
      children: [
        {
          id: "el-000000000002",
          backend: "atspi",
          role: "push button",
          name: "Open",
          states: [],
          actions: ["click"],
        },
      ],
    };
    expect(element.children?.[0].name).toBe("Open");
  });

  it("bounds inspection in the type, not only at runtime", () => {
    const params: InspectWindowParams = { windowId: "win-1", depth: 3, maxNodes: 200 };
    expect(params.maxNodes).toBe(200);
  });
});

describe("the protocol's design constraints", () => {
  it("accepts no coordinates in any request", () => {
    for (const [name, spec] of Object.entries<any>(schema.methods)) {
      const fields = Object.keys(spec.params.properties ?? {});
      for (const banned of ["x", "y", "coordinates", "point", "bounds"]) {
        expect(fields, `${name} accepts ${banned}`).not.toContain(banned);
      }
    }
  });

  it("declares the deferred capability tiers rather than omitting them", () => {
    const tiers = Object.keys(schema.enums.capabilityTier.values);
    expect(tiers).toContain("app-native");
    expect(tiers).toContain("vision");
    expect(tiers).toContain("raw-input");
  });

  it("declares the permission errors segment 3 will raise", () => {
    const codes = Object.keys(schema.enums.errorCode.values);
    expect(codes).toContain("PERMISSION_DENIED");
    expect(codes).toContain("SESSION_EXPIRED");
  });
});
