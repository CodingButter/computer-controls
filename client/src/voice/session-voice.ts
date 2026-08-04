import { CompositeVoice, type MastraVoice } from "@mastra/core/voice";
import { OpenAIVoice } from "@mastra/voice-openai";
import { isRefusal, type VoiceCredential, type VoiceRefusal } from "./credentials.ts";

/**
 * The speaker is pinned here rather than left to the provider's default.
 * A default is a value nobody chose: it can move in a patch release and the
 * agent comes back in a different voice, which reads as something being wrong
 * with the agent rather than with a config file. Every speak call names this.
 */
export const VOICE_SPEAKER = "nova";

export const LISTENING_MODEL = "whisper-1";
export const SPEECH_MODEL = "tts-1";

/**
 * `@mastra/voice-openai` bundles its own copy of the `MastraVoice` declaration
 * instead of importing the one in `@mastra/core`. The two files are identical
 * except that the `MastraBase` underneath them carries a `#private` brand, and
 * a private field makes two otherwise identical classes nominally distinct — so
 * TypeScript refuses the assignment that JavaScript performs without noticing.
 *
 * The cast is confined to this one function, and `hands the ear and the mouth
 * to CompositeVoice` in the test file is what keeps it honest: it drives a real
 * `OpenAIVoice` through a real `CompositeVoice` and fails if the shapes ever
 * genuinely diverge.
 */
function asVoiceProvider(voice: OpenAIVoice): MastraVoice {
  return voice as unknown as MastraVoice;
}

/**
 * Builds the ears and the mouth. Returns `undefined` when there is no OpenAI
 * credential — an agent constructed without a `voice` falls back to core's
 * `DefaultVoice`, whose errors the voice routes already turn into an honest
 * refusal. There is nothing to invent for the disabled case.
 *
 * Two `OpenAIVoice` instances, not one, because the point of `CompositeVoice`
 * is that the ear and the mouth are separately replaceable: the fluent tier
 * swaps the input for the realtime provider and leaves the output alone.
 */
export function createSessionVoice(
  credential: VoiceCredential | VoiceRefusal,
  transport: { fetch?: typeof globalThis.fetch } = {},
): CompositeVoice | undefined {
  if (isRefusal(credential)) return undefined;

  const apiKey = credential.key;
  const options = transport.fetch ? { fetch: transport.fetch } : {};

  // `OpenAIVoice` builds both clients in its constructor and throws unless both
  // were given a key, so each instance is handed the credential twice even
  // though `CompositeVoice` only ever calls one half of it. Passing the key
  // only to the half in use fails with "No API key provided for speech model".
  return new CompositeVoice({
    input: asVoiceProvider(
      new OpenAIVoice({
        listeningModel: { name: LISTENING_MODEL, apiKey, options },
        speechModel: { apiKey, options },
      }),
    ),
    output: asVoiceProvider(
      new OpenAIVoice({
        speechModel: { name: SPEECH_MODEL, apiKey, options },
        listeningModel: { apiKey, options },
        speaker: VOICE_SPEAKER,
      }),
    ),
  });
}
