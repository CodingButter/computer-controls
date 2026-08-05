import { describe, expect, it } from "vitest";

import * as hub from "./index";

/**
 * The barrel is the only file every page's data layer shares, so it is the one
 * place two branches can collide. This pins what it must keep offering: a slice
 * dropped from the barrel compiles fine and breaks a page at runtime.
 */
describe("the hub barrel", () => {
  it("re-exports every slice's entry point", () => {
    for (const name of [
      "getHealth",
      "getOrbStatus",
      "getPermissions",
      "putAccess",
      "getFlows",
      "getVoiceProviders",
      "getAudit",
    ] as const) {
      expect(typeof hub[name], name).toBe("function");
    }
  });
});
