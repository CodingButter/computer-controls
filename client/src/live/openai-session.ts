/**
 * The OpenAI Realtime transport, implementing the same seam `live.ts` declared
 * and `session.ts` proved against Gemini Live.
 *
 * One WebSocket to OpenAI's Realtime endpoint. The protocol is JSON events
 * rather than Gemini's four-message-kind model: the server sends typed events
 * (`response.audio.delta`, `response.function_call_arguments.done`, etc.) and
 * the client sends its own (`input_audio_buffer.append`, `conversation.item.create`).
 *
 * Authentication is browser-safe: the ephemeral token the hub minted rides
 * the WebSocket subprotocol, never a header the browser's WebSocket API
 * cannot set. The token is single-use — `mintToken` is called before every
 * dial, including redials — so a token that opened one session opens nothing
 * on the next.
 *
 * The session starts MUTED. The privacy property the orb asserts — idle audio
 * never leaves the machine — has to hold from the first instant of a
 * connection, not from the first time somebody remembers to call mute().
 *
 * The socket constructor is injectable so every frame this module sends and
 * every frame it interprets is pinned by tests without a network, the same
 * way the Gemini transport is tested. The live proof against OpenAI's real
 * endpoint is a separate artifact.
 */

import type {
  FunctionCall,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSession,
} from "./live.ts";
import type { SocketCloseEvent, SocketLike } from "./session.ts";
import { unrefTimer, defaultRetryWait } from "./session.ts";
import type { RetryWait } from "./session.ts";

export const OPENAI_REALTIME_ENDPOINT = "wss://api.openai.com/v1/realtime";

/** How long connect waits for the server's session.created before refusing. */
export const SETUP_TIMEOUT_MS = 15_000;

export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000];

/** The subprotocol prefix OpenAI's WebSocket expects the token under. */
const TOKEN_PROTOCOL = "openai-insecure-api-key";

const BETA_PROTOCOL = "openai-beta.realtime-v1";

/**
 * What a close reason looks like when the model itself is the thing the
 * provider will not accept. OpenAI names model problems in its error events
 * rather than close codes, but a permanent close during setup follows the
 * same pattern the Gemini transport handles.
 */
const MODEL_REFUSAL =
  /not found|not supported|unsupported|does not exist|is not available|no longer available|invalid|deprecat/i;

function isPermanentClose(code: number, reason: string): boolean {
  if (code >= 4000) return true;
  return code === 1008 && MODEL_REFUSAL.test(reason);
}

function formatRefusal(model: string, reason: string): string {
  const trimmed = reason.trim();
  return trimmed
    ? `The realtime voice provider refused the model '${model}': ${trimmed}`
    : `The realtime voice provider refused the model '${model}'.`;
}

/**
 * The subset of WebSocket this module uses, with subprotocols. Same shape as
 * `SocketLike` from session.ts but the factory receives protocols because the
 * token rides them.
 */
export type OpenAISocketFactory = (url: string, protocols: string[]) => SocketLike;

/** Server event types this module reacts to. */
type ServerEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { type?: string; code?: string; message?: string };
};

function decodeEvent(data: unknown): ServerEvent | undefined {
  const utf8 = new TextDecoder();
  try {
    if (typeof data === "string") return JSON.parse(data) as ServerEvent;
    if (data instanceof ArrayBuffer) return JSON.parse(utf8.decode(data)) as ServerEvent;
    if (ArrayBuffer.isView(data)) return JSON.parse(utf8.decode(data)) as ServerEvent;
  } catch {
    // A frame that does not parse is a frame we never saw.
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array | undefined {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Build the provider. `socketFactory` defaults to the runtime's own
 * WebSocket, passing the token in the subprotocol — the browser-safe path
 * that the hub's ephemeral `ek_` secret was minted for.
 */
export function openaiRealtimeProvider(
  socketFactory: OpenAISocketFactory = (url, protocols) =>
    new WebSocket(url, protocols) as unknown as SocketLike,
  retryWait: RetryWait = defaultRetryWait,
): RealtimeProvider {
  return {
    async connect(config: RealtimeConfig): Promise<RealtimeSession> {
      // Token dials mint fresh per dial — a single-use token that opened one
      // session has nothing left to open another with.
      const dialUrl = async (): Promise<{ url: string; protocols: string[] }> => {
        const token = config.mintToken ? await config.mintToken() : config.apiKey;
        const url = `${OPENAI_REALTIME_ENDPOINT}?model=${encodeURIComponent(config.model)}`;
        return { url, protocols: ["realtime", `${TOKEN_PROTOCOL}.${token}`, BETA_PROTOCOL] };
      };

      let muted = true;
      let closedByUs = false;
      let current: SocketLike | undefined;

      const dial = async (): Promise<void> => {
        const { url, protocols } = await dialUrl();
        return new Promise<void>((resolve, reject) => {
          const socket = socketFactory(url, protocols);
          if ("binaryType" in socket) socket.binaryType = "arraybuffer";
          let settled = false;
          const deadline = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.close();
            reject(new Error(`The realtime server did not complete setup within ${SETUP_TIMEOUT_MS}ms.`));
          }, SETUP_TIMEOUT_MS);
          unrefTimer(deadline);

          socket.addEventListener("open", () => {
            if (settled) return;
            settled = true;
            current = socket;
            resolve();
          });

          socket.addEventListener("message", ((event: { data: unknown }) => {
            const message = decodeEvent(event.data);
            if (!message) return;

            switch (message.type) {
              case "response.audio.delta": {
                if (message.delta) {
                  const bytes = base64ToBytes(message.delta);
                  if (bytes) config.events.onAudio(bytes);
                }
                break;
              }
              case "response.audio_transcript.done": {
                if (message.transcript) {
                  config.events.onTranscript(message.transcript, "assistant");
                }
                break;
              }
              case "conversation.item.input_audio_transcription.completed": {
                if (message.transcript) {
                  config.events.onTranscript(message.transcript, "user");
                }
                break;
              }
              case "response.function_call_arguments.done": {
                if (!message.name) break;
                let request: string | undefined;
                try {
                  request = message.arguments ? JSON.parse(message.arguments).request : undefined;
                } catch {
                  // Malformed arguments — treat as empty, same as Gemini.
                }
                config.events.onFunctionCall({
                  id: message.call_id ?? "",
                  name: message.name,
                  args: request !== undefined ? { request } : {},
                } satisfies FunctionCall);
                break;
              }
              case "input_audio_buffer.speech_started": {
                config.events.onBargeIn();
                break;
              }
              case "error": {
                const msg = message.error?.message ?? "unknown error";
                if (MODEL_REFUSAL.test(msg)) {
                  closedByUs = true;
                  config.events.onRefusal?.(formatRefusal(config.model, msg));
                } else {
                  console.warn(`[orb] openai realtime error: ${msg}`);
                }
                break;
              }
            }
          }) as (event: never) => void);

          socket.addEventListener("close", ((event: SocketCloseEvent) => {
            if (!settled) {
              if (isPermanentClose(event.code, event.reason)) {
                settled = true;
                reject(new Error(formatRefusal(config.model, event.reason)));
                return;
              }
              settled = true;
              reject(new Error("The realtime socket closed before setup completed."));
              return;
            }
            if (current !== socket) return;
            current = undefined;
            if (!closedByUs) {
              if (isPermanentClose(event.code, event.reason)) {
                closedByUs = true;
                config.events.onRefusal?.(formatRefusal(config.model, event.reason));
              } else {
                console.warn(
                  `[orb] openai realtime socket dropped by the server (${event.code}${
                    event.reason ? `: ${event.reason}` : ""
                  }); redialing`,
                );
                void redial();
              }
            }
          }) as (event: never) => void);

          socket.addEventListener("error", () => {
            if (!settled) {
              settled = true;
              reject(new Error("The realtime socket failed before setup completed."));
            }
          });
        });
      };

      let nudge: (() => void) | undefined;

      const redial = async (): Promise<void> => {
        for (let attempt = 0; !closedByUs; attempt++) {
          await Promise.race([
            retryWait(attempt),
            new Promise<void>((resolve) => {
              nudge = resolve;
            }),
          ]);
          nudge = undefined;
          if (closedByUs) return;
          try {
            await dial();
            console.warn("[orb] openai realtime socket reconnected");
            config.events.onReconnect?.();
            return;
          } catch {
            // The next lap waits longer and tries again.
          }
        }
      };

      await dial();

      return {
        sendAudio(chunk: Uint8Array): void {
          if (muted || closedByUs || !current) return;
          current.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: bytesToBase64(chunk),
            }),
          );
        },

        async sendText(text: string): Promise<void> {
          if (!current) return;
          current.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
              },
            }),
          );
          current.send(JSON.stringify({ type: "response.create" }));
        },

        async sendFunctionResult(id: string, result: string): Promise<void> {
          if (!current) return;
          current.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: id,
                output: result,
              },
            }),
          );
        },

        mute(): void {
          muted = true;
        },
        unmute(): void {
          muted = false;
          nudge?.();
        },
        get muted(): boolean {
          return muted;
        },
        get connected(): boolean {
          return !closedByUs && current !== undefined;
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
