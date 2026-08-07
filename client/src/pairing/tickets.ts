/**
 * The pairing ceremony's short half: a ticket that turns into a credential once.
 *
 * The problem this solves is bootstrapping. A phone arriving at this hub for
 * the first time holds nothing, so the door on `/events` — which admits either
 * a loopback peer or a minted credential — has no answer for it. Pairing is the
 * one moment a stranger is allowed to become a device, and a ticket is what
 * makes that moment safe to hold open.
 *
 * The ticket is the consent. It is minted only for a caller the kernel says is
 * on this machine (the person sitting at the dashboard pressed a button), it is
 * rendered as a QR code on that person's screen, and a phone that can read that
 * screen is a phone that person is holding. Nothing else vouches for the phone,
 * which is why the ticket's properties carry the whole weight:
 *
 *   short-lived — a code on a screen is a credential in the room. It expires on
 *                 its own so walking away is not the same as leaving a door
 *                 open, and the page can say when it stops working rather than
 *                 showing a code that silently went stale.
 *   single-use  — redemption consumes it. A QR photographed over a shoulder is
 *                 worthless the moment the intended phone has used it, and two
 *                 phones can never ride one ceremony.
 *   in memory   — tickets are never written to disk. A pairing window that
 *                 survived a hub restart would be a live credential nobody
 *                 remembers granting; a restart mid-pairing costs one button
 *                 press, which is the cheaper failure.
 *
 * What a redeemed ticket produces is an ordinary entry in the device credential
 * store — the same store the `/events` door was already checking. Pairing mints
 * into the lock that existed; it does not add a second way in.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** How long a code on a screen stays good for. Long enough to walk over, short enough to forget. */
export const TICKET_TTL_MS = 2 * 60 * 1000;

/** What the phone is told to call itself when it does not say. */
export const DEFAULT_DEVICE_LABEL = "A paired phone";

/**
 * Labels are the one caller-supplied string that reaches the store, so it is
 * bounded here rather than trusted. A device name is a person's words for their
 * own phone, not a place to park a payload.
 */
export const MAX_LABEL_LENGTH = 60;

export type PairingTicket = {
  /** The secret itself. Shown as a QR and never persisted. */
  code: string;
  /** When it stops working, so the page can count down instead of guessing. */
  expiresAt: number;
};

export type TicketMint = {
  /** Mint a ticket, replacing any ticket still outstanding. */
  issue(): PairingTicket;
  /**
   * Spend a code. Returns the label to pair under when the code was good, or
   * undefined when it was wrong, expired, or already spent — one shape for
   * every refusal, because a caller that could tell "expired" from "wrong"
   * could map the ceremony one guess at a time.
   */
  redeem(code: string, label: string): string | undefined;
  /** The outstanding ticket, if one is still live. For the page's countdown. */
  outstanding(): PairingTicket | undefined;
};

/**
 * One ticket at a time, deliberately.
 *
 * A hub with a queue of live pairing codes is a hub where a forgotten press
 * three minutes ago is still a door. Issuing replaces, so the code on the
 * screen is always the only code that works.
 */
export function createTicketMint(now: () => number = Date.now): TicketMint {
  let ticket: PairingTicket | undefined;

  const live = (): PairingTicket | undefined => {
    if (ticket && ticket.expiresAt <= now()) ticket = undefined;
    return ticket;
  };

  return {
    issue(): PairingTicket {
      ticket = {
        code: randomBytes(32).toString("base64url"),
        expiresAt: now() + TICKET_TTL_MS,
      };
      return ticket;
    },

    redeem(code: string, label: string): string | undefined {
      const current = live();
      // The comparison runs even with no outstanding ticket, against a value
      // the caller cannot have. "Nothing to redeem" and "wrong code" refuse
      // identically and cost the same.
      const expected = digest(current ? current.code : randomBytes(32).toString("base64url"));
      const offered = digest(code);
      if (!timingSafeEqual(expected, offered) || !current) return undefined;
      // Spent. Consumed before the caller is told it worked, so a second
      // request racing the first finds nothing rather than a second grant.
      ticket = undefined;
      return cleanLabel(label);
    },

    outstanding(): PairingTicket | undefined {
      return live();
    },
  };
}

/**
 * A label a person will read back off a list, with the shapes that make a list
 * lie removed: no newlines to forge a second row, no padding to hide behind,
 * and a length a row can actually render.
 */
export function cleanLabel(label: string): string {
  const flattened = label.replace(/\s+/g, " ").trim();
  if (!flattened) return DEFAULT_DEVICE_LABEL;
  return flattened.slice(0, MAX_LABEL_LENGTH);
}

/** Equal-length buffers, which `timingSafeEqual` requires and raw codes do not guarantee. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
