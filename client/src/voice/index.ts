/**
 * The voice lane: a mouth and ears for the session agent, and a button that
 * uses them.
 *
 * Two seams, and the client scaffold only needs these: `resolveVoiceProvider`
 * decides which mouth this machine wears, and `createSessionVoice` builds it
 * (or returns `undefined`, which is how voice is turned off). The browser half
 * lives in `public/app.js`, where the page that ships it can load it.
 * Everything between them belongs to Mastra already.
 */

export {
  OPENAI_PROVIDER_ID,
  isRefusal,
  resolveVoiceCredential,
  resolveVoiceProvider,
  type VoiceCredential,
  type VoiceCredentialKind,
  type VoiceRefusal,
} from "./credentials.ts";

export {
  VOICE_PROVIDERS,
  VOICE_PROVIDER_IDS,
  hasVoiceCredential,
  listVoiceProviders,
  parseVoiceProviderId,
  type VoiceLane,
  type VoiceProviderDescriptor,
  type VoiceProviderId,
  type VoiceProviderView,
} from "./providers.ts";

export {
  LISTENING_MODEL,
  SPEECH_MODEL,
  VOICE_SPEAKER,
  buildableVoiceProviders,
  createSessionVoice,
} from "./session-voice.ts";
