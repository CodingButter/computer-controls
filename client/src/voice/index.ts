/**
 * The voice lane: a mouth and ears for the session agent, and a button that
 * uses them.
 *
 * Two seams, and the client scaffold only needs these two. `createSessionVoice`
 * produces the agent's `voice` field (or `undefined`, which is how voice is
 * turned off). `createPushToTalk` drives the core voice routes from the browser.
 * Everything between them belongs to Mastra already.
 */

export {
  OPENAI_PROVIDER_ID,
  isRefusal,
  resolveVoiceCredential,
  type VoiceCredential,
  type VoiceCredentialKind,
  type VoiceRefusal,
} from "./credentials.ts";

export {
  LISTENING_MODEL,
  SPEECH_MODEL,
  VOICE_SPEAKER,
  createSessionVoice,
} from "./session-voice.ts";

export {
  createPushToTalk,
  probeVoice,
  type PushToTalkPorts,
  type Recording,
  type TurnResult,
  type VoiceAvailability,
  type VoiceTransport,
} from "./push-to-talk.ts";
