/**
 * The voice lane: a mouth and ears for the session agent, and a button that
 * uses them.
 *
 * One seam, and the client scaffold only needs this one: `createSessionVoice`
 * produces the agent's `voice` field (or `undefined`, which is how voice is
 * turned off). The browser half lives in `public/app.js`, where the page that
 * ships it can load it. Everything between them belongs to Mastra already.
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
