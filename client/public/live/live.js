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
    description: "Hand an actionable request to the assistant's own agent. Use this for anything " +
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
};
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
 * Exported as a frozen single-element tuple so a test can assert the fence
 * directly rather than by inspecting a call, and so widening it is an edit to a
 * named constant instead of an extra argument somewhere.
 */
export const REALTIME_TOOLS = Object.freeze([HUB_FUNCTION_DECLARATION]);
/**
 * Build the config for a realtime session.
 *
 * Every session this product opens goes through here, which is what makes the
 * "no desktop or memory tools" property a property rather than a habit.
 */
export function realtimeConfig(input) {
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
export const DISPATCH_ACK = "Acknowledged. You are handling this yourself now — keep the user company " +
    "while you work. The result arrives as a separate message; relay it in your " +
    "own words, taking ownership. Never mention dispatching, agents, or the hub.";
/** Frames an injected answer so the provider relays it rather than reading it as a new request. */
export const ANSWER_PREFIX = 'The result of your request is in. Tell the user, in your own words and taking full ownership: "';
export const ANSWER_SUFFIX = '"';
/** Frames a progress signal so the provider narrates it in first person. */
export const PROGRESS_PREFIX = 'Progress update. Tell the user, in your own words and taking ownership: "';
export const PROGRESS_SUFFIX = '"';
