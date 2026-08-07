/**
 * Where a paired phone keeps the credential it was given, and how it reads the
 * code it was sent.
 *
 * The credential is the phone's proof to the `/events` door, and it is returned
 * exactly once by the redeem route — nothing on the hub will hand it over
 * again. So it is kept, and `localStorage` is where it goes: it must survive
 * the tab closing, which rules out `sessionStorage`, and it must be readable by
 * script to be presented as a socket subprotocol, which rules out any cookie
 * arrangement that would protect it better.
 *
 * That is a real limit and worth naming rather than dressing up: anything that
 * can run script on this origin can read this value. It is the same exposure a
 * bearer token in a browser always has, and the mitigation is not clever
 * storage — it is that the credential names one device, is revocable from the
 * machine, and never leaves the origin that issued it.
 */

import type { PairedCredential } from "./hub";

const KEY = "comcon.device-credential";

/**
 * Pull the pairing code out of a URL fragment.
 *
 * The fragment is parsed rather than sliced so a scanner or a chat app that
 * appends its own tracking parameters does not turn the code into a code plus
 * whatever it added. Anything that is not a `c=` parameter is not a code.
 */
export function readPairingCode(hash: string): string | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return undefined;
  const code = new URLSearchParams(raw).get("c");
  return code === null || code === "" ? undefined : code;
}

export function storeCredential(credential: PairedCredential): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(credential));
  } catch {
    // A phone in private mode, or with storage full, still paired — the hub
    // recorded it. What is lost is this phone's ability to prove it later,
    // which it will discover when it next opens the socket.
  }
}

export function readCredential(): PairedCredential | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || typeof parsed.secret !== "string") return undefined;
    return {
      id: parsed.id,
      secret: parsed.secret,
      label: typeof parsed.label === "string" ? parsed.label : "This phone",
    };
  } catch {
    return undefined;
  }
}

/**
 * The subprotocol the `/events` door expects, assembled here so the exact
 * spelling lives next to the credential rather than at each call site.
 */
export function deviceSubprotocol(credential: PairedCredential): string {
  return `comcon-device.${credential.id}.${credential.secret}`;
}
