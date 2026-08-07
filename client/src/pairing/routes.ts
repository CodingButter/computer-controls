/**
 * The two doors of the pairing ceremony, which are deliberately not the same door.
 *
 * Minting is for the person at the machine. `POST /api/pairing/ticket` is
 * refused unless the kernel says the caller is on this host, because the whole
 * consent story is "someone sitting here pressed a button and a QR appeared on
 * their screen". A mint reachable from the network would be a lock that hands
 * out its own keys.
 *
 * Redeeming is for the phone, and it is the one route in this hub that must
 * answer a stranger holding no credential — that is what bootstrapping means.
 * It is safe only because of what the ticket is (see tickets.ts): high entropy,
 * two minutes, one use, never on disk. Redemption is also the only route that
 * ever returns a secret, and it returns it exactly once to the caller that
 * spent the ticket.
 *
 * Revocation lives with the mint, on the machine: a lost phone is revoked from
 * somewhere other than the phone that has it (#35's hard part 3), so the door
 * that forgets a device is the local one and never the paired one.
 */

import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

import { isLocalPeer } from "../events/index.ts";
import type { DeviceCredentialStore } from "../events/index.ts";
import { DEFAULT_DEVICE_LABEL, type TicketMint } from "./tickets.ts";

export const PAIRING_TICKET_PATH = "/api/pairing/ticket";
export const PAIRING_REDEEM_PATH = "/api/pairing/redeem";
export const PAIRING_DEVICE_PATH = "/api/pairing/devices/:id";

/** One shape for every redemption refusal. See tickets.ts for why. */
const REDEEM_REFUSED = "That pairing code is not usable. Show a new QR code on the hub and try again.";

const NOT_LOCAL =
  "Pairing codes are issued on the machine running the hub, not over the network.";

export type PairingMount = {
  tickets: TicketMint;
  credentials: DeviceCredentialStore;
};

export function buildPairingApp(mount: PairingMount): Hono {
  const app = new Hono();

  app.post(PAIRING_TICKET_PATH, (c) => {
    if (!local(c)) return c.json({ error: NOT_LOCAL }, 403);
    const ticket = mount.tickets.issue();
    // The code travels to the page that will draw it, and the page is on this
    // machine. The expiry travels with it so the card can say when the code
    // dies instead of showing one that already has.
    return c.json({ code: ticket.code, expiresAt: ticket.expiresAt });
  });

  app.post(PAIRING_REDEEM_PATH, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const code = (body as { code?: unknown } | undefined)?.code;
    const label = (body as { label?: unknown } | undefined)?.label;
    if (typeof code !== "string") return c.json({ error: REDEEM_REFUSED }, 403);

    const named = mount.tickets.redeem(
      code,
      typeof label === "string" ? label : DEFAULT_DEVICE_LABEL,
    );
    if (named === undefined) return c.json({ error: REDEEM_REFUSED }, 403);

    const credential = await mount.credentials.mint(named);
    // The only time a secret leaves this hub, to the caller that spent the
    // ticket, once. Nothing logs it and no other route will ever return it.
    return c.json({ id: credential.id, secret: credential.secret, label: credential.label });
  });

  app.delete(PAIRING_DEVICE_PATH, async (c) => {
    if (!local(c)) return c.json({ error: NOT_LOCAL }, 403);
    const removed = await mount.credentials.revoke(c.req.param("id"));
    // Revoking something already gone is the state the caller asked for, so it
    // is not an error — but the answer says which happened.
    return c.json({ revoked: removed });
  });

  return app;
}

/**
 * The kernel's account of the peer, never a header.
 *
 * `x-forwarded-for` is written by the caller, so consulting it here would be
 * asking the stranger whether he is a stranger. This mirrors the `/events`
 * door exactly — same helper, same reasoning — so the two places that decide
 * "is this the machine itself" can never drift apart.
 */
function local(c: Context): boolean {
  try {
    return isLocalPeer(getConnInfo(c).remote.address);
  } catch {
    // No connection info is not a claim of locality.
    return false;
  }
}
