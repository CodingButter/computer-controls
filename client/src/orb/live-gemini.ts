/**
 * The real Gemini Live transport, implementing the seam `live.ts` declared.
 *
 * One WebSocket to Google's BidiGenerateContent endpoint. The protocol is
 * four client message kinds — setup, clientContent, realtimeInput,
 * toolResponse — and the session is not usable until the server answers the
 * setup with setupComplete.
 *
 * The session starts MUTED. The privacy property the orb asserts — idle
 * audio never leaves the machine — has to hold from the first instant of a
 * connection, not from the first time somebody remembers to call mute().
 * The wake gate unmutes; nothing else does.
 *
 * The socket constructor is injectable so every frame this module sends and
 * every frame it interprets is pinned by tests without a network. The live
 * proof against Google's real endpoint is a separate artifact — a test that
 * passes here says the wire format is what we decided, not that Google
 * agrees with it.
 */

import type {
  FunctionCall,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSession,
} from "./live.ts";

export const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** What the orb is, to the voice that fronts it. */
export const ORB_SYSTEM_INSTRUCTION =
  "You are the voice of this computer's assistant. Converse naturally and " +
  "briefly. You do not know what this computer's assistant can or cannot do: " +
  "it has its own tools, its own access, and its own limits, none of which " +
  "are visible to you. Therefore you must never refuse a request or declare " +
  "it impossible. For anything actionable — acting on the computer, reading " +
  "applications or files, checking messages or email, remembering, looking " +
  "things up — call ask_the_hub with the user's request in their own words, " +
  "and relay its answer, including its refusals. Only it may say no. Never " +
  "claim to have done something yourself.";

/** How long connect waits for the server's setupComplete before refusing. */
export const SETUP_TIMEOUT_MS = 15_000;

/**
 * Google hangs up on idle realtime sessions after a few minutes. A session
 * object that treats that hangup as permanent turns a routine server-side
 * timeout into a deaf orb: the gate opens, audio pours in, and every frame
 * is silently dropped on a socket that will never speak again. So a drop
 * that this side did not ask for is redialed, forever, on this schedule —
 * the last delay repeats. What a redial cannot restore is the conversation
 * so far: the new socket starts a fresh session.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000];

/** Injectable so tests redial instantly instead of waiting out the backoff. */
export type RetryWait = (attempt: number) => Promise<void>;

const defaultRetryWait: RetryWait = (attempt) =>
  new Promise((resolve) => {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(resolve, delay);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });

/** The subset of WebSocket this module uses, injectable for tests. */
export type SocketLike = {
  /**
   * Asked for as arraybuffer because the server frames its JSON as binary and
   * the runtime's default is Blob — a shape `decodeFrame` would have to go
   * async to read, which would reorder messages behind their own decoding.
   */
  binaryType?: string;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
};

export type SocketFactory = (url: string) => SocketLike;

type ServerMessage = {
  setupComplete?: object;
  serverContent?: {
    interrupted?: boolean;
    turnComplete?: boolean;
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: {
    functionCalls?: Array<{ id?: string; name?: string; args?: { request?: string } }>;
  };
};

function decodeFrame(data: unknown): ServerMessage | undefined {
  try {
    if (typeof data === "string") return JSON.parse(data) as ServerMessage;
    if (data instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(data).toString("utf8")) as ServerMessage;
    }
    if (ArrayBuffer.isView(data) || Buffer.isBuffer(data)) {
      return JSON.parse(Buffer.from(data as Uint8Array).toString("utf8")) as ServerMessage;
    }
  } catch {
    // A frame that does not parse is a frame we never saw. The protocol has
    // no in-band recovery for it, and guessing at half a message is worse.
  }
  return undefined;
}

/**
 * Build the provider. `socketFactory` defaults to the runtime's own
 * WebSocket — Node has had one since 22, and the hub pins newer.
 */
export function geminiLiveProvider(
  socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
  retryWait: RetryWait = defaultRetryWait,
): RealtimeProvider {
  return {
    async connect(config: RealtimeConfig): Promise<RealtimeSession> {
      const url = `${LIVE_ENDPOINT}?key=${encodeURIComponent(config.apiKey)}`;

      let muted = true;
      /** True only when this side hung up. A server drop is not this. */
      let closedByUs = false;
      /** The socket that has completed setup, or undefined during a gap. */
      let current: SocketLike | undefined;

      const setup = {
        setup: {
          model: `models/${config.model}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: ORB_SYSTEM_INSTRUCTION }] },
          tools: [
            {
              functionDeclarations: config.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
          // Both directions transcribed: captions and the chat drawer are
          // fed from these, and a conversation nobody can re-read is a
          // conversation the audit story cannot tell.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };

      const dial = (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const socket = socketFactory(url);
          if ("binaryType" in socket) socket.binaryType = "arraybuffer";
          let settled = false;
          // A handshake that never answers must become a refusal, not a hub
          // that hangs at boot with its port unbound — which is precisely what
          // happened when an undecodable frame carried the setupComplete.
          const deadline = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.close();
            reject(new Error(`The realtime server did not complete setup within ${SETUP_TIMEOUT_MS}ms.`));
          }, SETUP_TIMEOUT_MS);
          if (typeof deadline === "object" && "unref" in deadline) deadline.unref();
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify(setup));
          });
          socket.addEventListener("message", ((event: { data: unknown }) => {
            const message = decodeFrame(event.data);
            if (!message) return;

            if (message.setupComplete && !settled) {
              settled = true;
              // Becoming `current` happens here, inside the handshake, so a
              // close event can never race the assignment and mistake a live
              // socket for a stale one.
              current = socket;
              resolve();
              return;
            }

            const content = message.serverContent;
            if (content) {
              if (content.interrupted) config.events.onBargeIn();
              for (const part of content.modelTurn?.parts ?? []) {
                const inline = part.inlineData;
                if (inline?.data && (inline.mimeType ?? "").startsWith("audio/pcm")) {
                  config.events.onAudio(Uint8Array.from(Buffer.from(inline.data, "base64")));
                }
              }
              if (content.inputTranscription?.text) {
                config.events.onTranscript(content.inputTranscription.text, "user");
              }
              if (content.outputTranscription?.text) {
                config.events.onTranscript(content.outputTranscription.text, "assistant");
              }
            }

            for (const call of message.toolCall?.functionCalls ?? []) {
              if (!call.name) continue;
              config.events.onFunctionCall({
                id: call.id ?? "",
                name: call.name,
                args: call.args ?? {},
              } satisfies FunctionCall);
            }
          }) as (event: never) => void);
          socket.addEventListener("close", () => {
            if (!settled) {
              settled = true;
              reject(new Error("The realtime socket closed before setup completed."));
              return;
            }
            // A stale socket dying — one already replaced by a redial — is
            // not news. Only the current socket's death matters.
            if (current !== socket) return;
            current = undefined;
            if (!closedByUs) {
              console.warn("[orb] realtime socket dropped by the server; redialing");
              void redial();
            }
          });
          socket.addEventListener("error", () => {
            if (!settled) {
              settled = true;
              reject(new Error("The realtime socket failed before setup completed."));
            }
          });
        });

      const redial = async (): Promise<void> => {
        for (let attempt = 0; !closedByUs; attempt++) {
          await retryWait(attempt);
          if (closedByUs) return;
          try {
            await dial();
            console.warn("[orb] realtime socket reconnected");
            return;
          } catch {
            // The next lap waits longer and tries again. Giving up would
            // reintroduce the deaf orb this loop exists to prevent.
          }
        }
      };

      // The first dial keeps its refusal semantics: a hub that cannot reach
      // the realtime endpoint at boot says so instead of pretending.
      await dial();

      return {
        sendAudio(chunk: Uint8Array): void {
          // The mute check lives here, at the last line before the wire.
          // Callers are expected to respect the gate; the session does not
          // rely on them having done so. During a redial gap the frame is
          // dropped — audio has no meaning to a session that missed it.
          if (muted || closedByUs || !current) return;
          current.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  mimeType: "audio/pcm;rate=16000",
                  data: Buffer.from(chunk).toString("base64"),
                },
              },
            }),
          );
        },

        async sendText(text: string): Promise<void> {
          if (!current) return;
          current.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text }] }],
                turnComplete: true,
              },
            }),
          );
        },

        async sendFunctionResult(id: string, result: string): Promise<void> {
          // A result for a call the previous socket made is meaningless to
          // the new one; dropped rather than confusing a fresh session.
          if (!current) return;
          current.send(
            JSON.stringify({
              toolResponse: {
                functionResponses: [{ id, response: { output: result } }],
              },
            }),
          );
        },

        mute(): void {
          muted = true;
        },
        unmute(): void {
          muted = false;
        },
        get muted(): boolean {
          return muted;
        },

        async close(): Promise<void> {
          closedByUs = true;
          current?.close();
          current = undefined;
        },
      };
    },
  };
}
