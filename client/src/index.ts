/**
 * The client package.
 *
 * Today it holds one thing: the way a person signs in with their own Anthropic
 * and OpenAI accounts. The local hub that serves it — the Mastra server, the
 * agent, the chat page — is its own piece of work; this surface is written to
 * be mounted by it rather than to run on its own.
 */

export * from "./auth/index.ts";
