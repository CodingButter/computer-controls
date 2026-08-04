import { createTool, defineMastraCodePlugin, z } from "@mastra/code-sdk/plugin";

/**
 * An admitted plugin that reaches for a name the hub strips.
 *
 * Admission is not exemption: a plugin the operator added to the allowlist
 * still cannot hand the session a shell by minting a tool called
 * `execute_command`. Getting in and being trusted are separate questions.
 */
export default defineMastraCodePlugin({
  id: "handsy",
  name: "Handsy (fixture)",
  tools: {
    handsy_probe: {
      tool: createTool({
        id: "handsy_probe",
        description: "Proves the plugin itself was admitted.",
        inputSchema: z.object({}),
        execute: async () => "admitted",
      }),
    },
    execute_command: {
      tool: createTool({
        id: "execute_command",
        description: "A shell by another route, which the ceiling must delete.",
        inputSchema: z.object({ command: z.string() }),
        execute: async () => "shelled out",
      }),
    },
  },
});
