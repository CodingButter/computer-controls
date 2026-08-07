/** /api/pairing — the ceremony that turns a stranger's phone into a device. */

import type { Fetched } from "./core";

export type PairingTicket = {
  /** The secret the QR carries. Held in memory for as long as it is on screen. */
  code: string;
  /** Epoch milliseconds. The card counts down to this rather than guessing. */
  expiresAt: number;
};

export type PairedCredential = {
  id: string;
  secret: string;
  label: string;
};

function parseTicket(body: unknown): PairingTicket {
  if (typeof body !== "object" || body === null) throw new Error("not a pairing ticket");
  const raw = body as Record<string, unknown>;
  if (typeof raw.code !== "string" || typeof raw.expiresAt !== "number") {
    throw new Error("not a pairing ticket");
  }
  return { code: raw.code, expiresAt: raw.expiresAt };
}

function parseCredential(body: unknown): PairedCredential {
  if (typeof body !== "object" || body === null) throw new Error("not a credential");
  const raw = body as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.secret !== "string") {
    throw new Error("not a credential");
  }
  return {
    id: raw.id,
    secret: raw.secret,
    label: typeof raw.label === "string" ? raw.label : "A paired phone",
  };
}

/**
 * A refusal from the hub is shown as the hub phrased it.
 *
 * The pairing routes answer every bad redemption with one sentence on purpose —
 * expired, wrong and already-spent are indistinguishable — so a page that
 * unpacked the status into its own guesses would hand back the distinction the
 * hub spent effort removing.
 */
async function post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<Fetched<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const said = (payload as { error?: unknown } | undefined)?.error;
      return {
        kind: "unreachable",
        detail: typeof said === "string" ? said : `${path} answered ${response.status}`,
      };
    }
    return { kind: "ok", data: parse(payload) };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Ask for a code to put on the screen. Refused unless this page is on the hub's machine. */
export function issueTicket(): Promise<Fetched<PairingTicket>> {
  return post("/api/pairing/ticket", {}, parseTicket);
}

/** Spend a code. This is the phone's call, made once, from the page the QR opened. */
export function redeemTicket(code: string, label: string): Promise<Fetched<PairedCredential>> {
  return post("/api/pairing/redeem", { code, label }, parseCredential);
}

/** Forget a paired device. Done from the machine, never from the phone that was lost. */
export async function revokeDevice(id: string): Promise<Fetched<{ revoked: boolean }>> {
  try {
    const response = await fetch(`/api/pairing/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return { kind: "unreachable", detail: `revoking answered ${response.status}` };
    }
    const body = (await response.json()) as { revoked?: unknown };
    return { kind: "ok", data: { revoked: body.revoked === true } };
  } catch (error) {
    return {
      kind: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * What the QR actually carries: this page's own origin, plus the code in the
 * fragment.
 *
 * The origin is read off the URL bar rather than asked of the hub, and that is
 * the whole reason the devices page can draw a QR without breaking its own
 * rule. The hub never names its address — it binds loopback and sits behind a
 * TLS proxy it knows nothing about — so an address minted server-side would be
 * both wrong and a fingerprint. The browser showing this page was already
 * reached at some address; reflecting it back adds no knowledge.
 *
 * The code rides in the fragment, which browsers do not send to servers. It
 * stays out of access logs and out of the `Referer` on anything the paired page
 * loads next.
 */
export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/pair#c=${encodeURIComponent(code)}`;
}

/**
 * Whether the address this page was reached at is one only this machine can
 * use. A QR of `localhost` scans perfectly and then fails on the phone, which
 * is a worse experience than being told up front.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}
