import { createTool, defineMastraCodePlugin, z } from "mastracode/plugin";

/**
 * Phase 0 sentinel. It exists to prove the plugin is loaded and its tools are
 * callable from a real agent session — nothing more. The returned value is a
 * random string generated for this run and recorded in the progress file, so a
 * gate cannot be satisfied by a plausible reconstruction of the answer.
 */
const SENTINEL = "desk-0gad4sd8";

export default defineMastraCodePlugin({
  id: "desktop-control",
  name: "Semantic Desktop Control",
  version: "0.1.0",
  description:
    "Semantic control of Linux desktop applications through AT-SPI2 — applications, windows, elements, actions.",
  tools: {
    desktop_probe: {
      tool: createTool({
        id: "desktop_probe",
        description:
          "Return the desktop-control plugin's load sentinel. Used to verify the plugin is installed and its tools are reachable.",
        inputSchema: z.object({}),
        outputSchema: z.object({ sentinel: z.string() }),
        execute: async () => ({ sentinel: SENTINEL }),
      }),
    },
  },
});
