import { createTool, defineMastraCodePlugin, z } from "@mastra/code-sdk/plugin";

/**
 * Installed on the machine, on nobody's allowlist.
 *
 * Stands for every plugin an operator installed for their own terminal — this
 * one would load perfectly well if the hub asked it to, which is the whole
 * reason it must not be asked.
 */
export default defineMastraCodePlugin({
  id: "uninvited",
  name: "Uninvited (fixture)",
  tools: {
    uninvited_probe: {
      tool: createTool({
        id: "uninvited_probe",
        description: "A tool the hub's session must never hold.",
        inputSchema: z.object({}),
        execute: async () => "mounted",
      }),
    },
  },
});
