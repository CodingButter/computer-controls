import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// Imported the way the browser imports it: the served asset itself, not a
// TypeScript twin of it. If this import ever resolves to something a browser
// would not load, these tests stop being about the shipping page.
import { HEARD_NOTHING, failureReason, handleListenResponse } from "../../public/app.js";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const exists = (relative: string) =>
  existsSync(fileURLToPath(new URL(relative, import.meta.url)));

describe("the browser half of the client", () => {
  it("test_the_shipped_page_and_the_tested_module_are_the_same_code", () => {
    // The parallel implementation is gone rather than kept in sync by hand.
    expect(exists("./push-to-talk.ts")).toBe(false);
    expect(exists("./push-to-talk.test.ts")).toBe(false);
    expect(read("./index.ts")).not.toContain("push-to-talk");

    // What is left ships: the page loads the module this file imports, and it
    // carries no second copy of the logic inline.
    const page = read("../../public/index.html");
    expect(page).toContain('<script type="module" src="/app.js"></script>');
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page).not.toContain("VOICE_BASE");

    // And the module is a real served asset, not a source file the server
    // would refuse to hand a browser.
    expect(exists("../../public/app.js")).toBe(true);
  });

  it("test_a_non_json_voice_refusal_reaches_the_user_as_its_reason", async () => {
    // The #96 defect: a refusal that is not JSON must arrive as itself, not as
    // a parse error about the explanation.
    const refusal = "Bad gateway: the voice route is not answering.";
    const res = new Response(refusal, { status: 502 });

    await expect(failureReason(res)).resolves.toBe(refusal);
  });

  it("test_an_empty_transcript_sends_no_turn", async () => {
    const sendTurn = vi.fn();
    const onHeardNothing = vi.fn();
    const res = Response.json({ text: "   " });

    await handleListenResponse(res, {
      onRefusal: vi.fn(),
      onHeardNothing,
      sendTurn,
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(onHeardNothing).toHaveBeenCalledOnce();
    expect(HEARD_NOTHING).toContain("nothing was sent");
  });
});
