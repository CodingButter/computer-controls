/**
 * The realtime provider, and the fence around it.
 *
 * Gemini Live is the mouth and the ears. It is fluent, it interrupts well, and
 * it holds a conversation — and it does not decide anything. Everything
 * actionable leaves this seam as a single function call into the hub's agent,
 * where the model pack chose the model and the daemon's consent ceiling decides
 * what may actually happen to the machine.
 *
 * That division is enforced by what the session is given rather than by what it
 * is told. The provider is handed exactly one tool declaration, `ask_the_hub`,
 * and there is no path from this file to the desktop tools, the workspace, or
 * memory. A prompt cannot argue its way to a capability that was never minted —
 * the same rule `toolbox.ts` applies to the coding runtime's own hands, applied
 * here to a provider that talks.
 *
 * `@mastra/voice-google-gemini-live-api` does not exist on npm today; the issue
 * anticipated that and permitted the raw Live API. So the transport is an
 * interface, and the hub talks to that interface. When the package ships, it
 * implements `RealtimeSession` and nothing above this line changes.
 */

/** The only tool the realtime provider is ever given. */
export const HUB_FUNCTION_NAME = "ask_the_hub";

/**
 * The tool declaration, in the shape the Live API expects.
 *
 * One function, one string argument. The narrowness is the design: a richer
 * schema would be a second place where capability is described, and the first
 * place is the agent it delegates to.
 */
export const HUB_FUNCTION_DECLARATION = {
  name: HUB_FUNCTION_NAME,
  description:
    "Hand an actionable request to the assistant's own agent. Use this for anything " +
    "that requires acting on the computer, reading files, remembering, or looking " +
    "something up. Do not attempt such things yourself.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "The user's request, in their own words.",
      },
    },
    required: ["request"],
  },
} as const;

/** A call the provider made back to us. */
export type FunctionCall = {
  id: string;
  name: string;
  args: { request?: string };
};

export type RealtimeEvents = {
  /** The provider produced audio for the speaker. */
  onAudio(chunk: Uint8Array): void;
  /** A transcript line, for captions and the chat drawer. */
  onTranscript(text: string, speaker: "user" | "assistant"): void;
  /** The provider wants the hub's agent. The only way anything gets done. */
  onFunctionCall(call: FunctionCall): void;
  /** The human started talking over the assistant. */
  onBargeIn(): void;
};

/**
 * The realtime transport, as the hub needs it.
 *
 * `mute`/`unmute` rather than connect/disconnect because the socket staying open
 * between wakes is the point — reconnecting costs a handshake at exactly the
 * moment somebody is waiting to be heard. Muted means no audio is written to it.
 */
export interface RealtimeSession {
  /** Send captured audio. Only ever called while the wake gate is open. */
  sendAudio(chunk: Uint8Array): void;
  /** Inject a text turn — how a signal reaches the orb's voice. */
  sendText(text: string): Promise<void>;
  /** Return the hub agent's answer for a function call the provider made. */
  sendFunctionResult(id: string, result: string): Promise<void>;
  mute(): void;
  unmute(): void;
  readonly muted: boolean;
  close(): Promise<void>;
}

/** What a provider must be handed to be built. */
export type RealtimeConfig = {
  apiKey: string;
  model: string;
  /** Always exactly the hub function. Present so the fence is visible at the call site. */
  tools: readonly [typeof HUB_FUNCTION_DECLARATION];
  /** Speak without waiting to be spoken to, where the provider supports it. */
  proactiveAudio: boolean;
  events: RealtimeEvents;
};

export interface RealtimeProvider {
  connect(config: RealtimeConfig): Promise<RealtimeSession>;
}

/** The Live model the orb runs. Pinned here for the same reason the speaker is. */
export const LIVE_MODEL = "gemini-2.0-flash-live-001";

/**
 * The tool set handed to any realtime session this product opens.
 *
 * Exported as a frozen single-element tuple so a test can assert the fence
 * directly rather than by inspecting a call, and so widening it is an edit to a
 * named constant instead of an extra argument somewhere.
 */
export const REALTIME_TOOLS = Object.freeze([HUB_FUNCTION_DECLARATION] as const);

/**
 * Build the config for a realtime session.
 *
 * Every session this product opens goes through here, which is what makes the
 * "no desktop or memory tools" property a property rather than a habit.
 */
export function realtimeConfig(input: {
  apiKey: string;
  events: RealtimeEvents;
  model?: string;
  proactiveAudio?: boolean;
}): RealtimeConfig {
  return {
    apiKey: input.apiKey,
    model: input.model ?? LIVE_MODEL,
    tools: REALTIME_TOOLS,
    proactiveAudio: input.proactiveAudio ?? true,
    events: input.events,
  };
}
