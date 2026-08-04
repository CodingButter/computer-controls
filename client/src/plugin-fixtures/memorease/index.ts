import { createTool, defineMastraCodePlugin, z } from "@mastra/code-sdk/plugin";

/**
 * A stand-in for the memory plugin the default allowlist admits by name.
 *
 * Same id as the real one, so the hub mounts it for exactly the reason the real
 * one gets mounted, on a machine where the real one was never installed.
 */
export default defineMastraCodePlugin({
  id: "memorease",
  name: "Memorease (fixture)",
  tools: {
    memorease_probe: {
      tool: createTool({
        id: "memorease_probe",
        description: "Proves the fixture's tools reached the session.",
        inputSchema: z.object({}),
        execute: async () => "remembered",
      }),
    },
  },
});
