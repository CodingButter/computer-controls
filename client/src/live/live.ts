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
 * is told. The provider is handed exactly two tool declarations — `ask_the_hub`
 * to delegate action, and `stop_listening` to end the voice session — and there
 * is no path from this file to the desktop tools, the workspace, or memory. A
 * prompt cannot argue its way to a capability that was never minted — the same
 * rule `toolbox.ts` applies to the coding runtime's own hands, applied here to a
 * provider that talks.
 *
 * `@mastra/voice-google-gemini-live-api` does not exist on npm today; the issue
 * anticipated that and permitted the raw Live API. So the transport is an
 * interface, and the hub talks to that interface. When the package ships, it
 * implements `RealtimeSession` and nothing above this line changes.
 */

/** Delegate an actionable request to the hub's own agent. */
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

/**
 * Close the voice session.
 *
 * The model — not an enumerated phrase list — decides when the user meant to
 * stop: "nevermind," "that's all," "go back to sleep," or anything that reads as
 * dismissal. Calling this releases the microphone and closes the session through
 * the same path a tab closing does. Ending the session does not cancel anything
 * the agent was asked to do; a task in progress keeps going. There is no tool to
 * open the session — the wake path (the press, the consent gesture) is the only
 * entrance, by design.
 */
export const STOP_LISTENING_NAME = "stop_listening";

export const STOP_LISTENING_DECLARATION = {
  name: STOP_LISTENING_NAME,
  description:
    "Close this listening session. Call this whenever the user means to stop talking — " +
    "dismissing a request, changing their mind, wrapping up, or any words that signal " +
    "they want the microphone off. You decide whether the user meant to stop; there is " +
    "no phrase to match. Ending the listening session does not cancel anything you were " +
    "asked to do — a task in progress keeps going.",
  parameters: {
    type: "object",
    properties: {},
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
  /** The socket reconnected after a server-side drop. Answers queued during the gap are flushed here. */
  onReconnect?(): void;
  /**
   * The provider permanently refused the connection (e.g. the model was
   * retired upstream). Redialing stops — retrying a model the provider has
   * rejected is how the orb went mute in the first place (#129). The reason
   * names the model so the person knows what to change.
   */
  onRefusal?(reason: string): void;
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
  /**
   * Whether a live socket currently backs this session. False during a
   * reconnect gap. A transport that never drops may simply return true;
   * one that redials should treat `unmute()` as a reason to redial NOW —
   * a person starting to talk is the worst moment to be waiting out a
   * backoff.
   */
  readonly connected: boolean;
  close(): Promise<void>;
}

/** What a provider must be handed to be built. */
export type RealtimeConfig = {
  apiKey: string;
  /**
   * When present, the session dials with hub-minted single-use ephemeral
   * tokens instead of `apiKey`: called before EVERY dial — including every
   * redial — because a token that opened one session has nothing left to
   * open another with. The constraints (model, instruction, the tools)
   * ride the token, minted server-side; this side never shapes them.
   */
  mintToken?: () => Promise<string>;
  model: string;
  /** Always exactly the two permitted tools. Present so the fence is visible at the call site. */
  tools: readonly [typeof HUB_FUNCTION_DECLARATION, typeof STOP_LISTENING_DECLARATION];
  /** Speak without waiting to be spoken to, where the provider supports it. */
  proactiveAudio: boolean;
  /** Which prebuilt voice the provider speaks with. Named, never inherited. */
  voice: string;
  events: RealtimeEvents;
};

export interface RealtimeProvider {
  connect(config: RealtimeConfig): Promise<RealtimeSession>;
}

/** The Live model the orb runs. Pinned here for the same reason the speaker is. */
export const LIVE_MODEL = "gemini-3.1-flash-live-preview";

/**
 * The voice the orb speaks with.
 *
 * Pinned because an unnamed voice is the provider's default, and a default is
 * free to move underneath a running product — which is exactly what it did:
 * the orb changed voice mid-project without a line of code changing. A voice
 * is part of what this thing *is* to the person talking to it, so it is named
 * here and overridable per session, never inherited.
 */
export const LIVE_VOICE = "Aoede";

/**
 * The tool set handed to any realtime session this product opens.
 *
 * Exported as a frozen tuple so a test can assert the fence directly rather than
 * by inspecting a call, and so widening it is an edit to a named constant
 * instead of an extra argument somewhere. Two tools and only two: `ask_the_hub`
 * to delegate action, `stop_listening` to end the session. No path to the
 * desktop, the workspace, or memory — and no tool to open a session.
 */
export const REALTIME_TOOLS = Object.freeze(
  [HUB_FUNCTION_DECLARATION, STOP_LISTENING_DECLARATION] as const,
);

/**
 * Build the config for a realtime session.
 *
 * Every session this product opens goes through here, which is what makes the
 * "no desktop or memory tools" property a property rather than a habit.
 */
export function realtimeConfig(input: {
  apiKey: string;
  mintToken?: () => Promise<string>;
  events: RealtimeEvents;
  model?: string;
  /** Overrides the pinned voice for this session; absent keeps LIVE_VOICE. */
  voice?: string;
  proactiveAudio?: boolean;
}): RealtimeConfig {
  return {
    apiKey: input.apiKey,
    ...(input.mintToken ? { mintToken: input.mintToken } : {}),
    model: input.model ?? LIVE_MODEL,
    tools: REALTIME_TOOLS,
    proactiveAudio: input.proactiveAudio ?? true,
    voice: input.voice ?? LIVE_VOICE,
    events: input.events,
  };
}

/**
 * The sentences that frame the ask_the_hub round trip, shared here because
 * two mouths now speak them: the hub's own session (until segment 06) and
 * the client mouth in the browser. One home keeps the voice from drifting
 * between them — the ownership framing IS the product's voice.
 */

/**
 * The immediate result returned for a dispatch, so the provider keeps its
 * voice while the hub works. First-person and ownership-framed: the provider
 * is told it is handling this itself, never that something was dispatched
 * elsewhere.
 */
export const DISPATCH_ACK =
  "Acknowledged. You are handling this yourself now — keep the user company " +
  "while you work. The result arrives as a separate message; relay it in your " +
  "own words, taking ownership. Never mention dispatching, agents, or the hub.";

/** Frames an injected answer so the provider relays it rather than reading it as a new request. */
export const ANSWER_PREFIX =
  'The result of your request is in. Tell the user, in your own words and taking full ownership: "';
export const ANSWER_SUFFIX = '"';

/** Frames a progress signal so the provider narrates it in first person. */
export const PROGRESS_PREFIX =
  'Progress update. Tell the user, in your own words and taking ownership: "';
export const PROGRESS_SUFFIX = '"';
