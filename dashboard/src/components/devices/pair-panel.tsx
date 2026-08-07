"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { QrCode } from "@/components/devices/qr-code";
import { issueTicket, isLoopbackOrigin, pairingUrl, type PairingTicket } from "@/lib/hub";

/**
 * The pairing ceremony as the person at the machine experiences it: press a
 * button, a code appears, point a phone at it, the code dies.
 *
 * Nothing here is shown before the button is pressed. A QR that is simply
 * always on the devices page is a live credential sitting on a monitor in an
 * office — the press is the consent, and it is why the hub refuses to mint one
 * for any caller it cannot see is local.
 *
 * The countdown is not decoration either. The hub's ticket expires on its own,
 * so a card without a clock would keep displaying a code that stopped working
 * a minute ago and the failure would land on the phone, which is the one place
 * that cannot explain it.
 */

/** How often the clock re-reads. A second is as fine as a countdown needs to be. */
const TICK_MS = 1_000;

function secondsLeft(ticket: PairingTicket, now: number): number {
  return Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000));
}

export function PairPanel() {
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticket) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticket]);

  const ask = useCallback(async () => {
    setAsking(true);
    setRefused(null);
    const answer = await issueTicket();
    setAsking(false);
    if (answer.kind === "unreachable") {
      setTicket(null);
      setRefused(answer.detail);
      return;
    }
    setNow(Date.now());
    setTicket(answer.data);
  }, []);

  const left = ticket ? secondsLeft(ticket, now) : 0;
  const expired = ticket !== null && left === 0;

  // Read off the URL bar, never asked of the hub — see pairingUrl for why that
  // distinction is what keeps this page from naming the machine.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="flex flex-col gap-3">
      {ticket === null || expired ? (
        <>
          <p className="text-sm text-muted">
            A pairing code is a credential on a screen. It lasts two minutes, works once,
            and is issued only to someone at this machine.
          </p>
          {expired ? (
            <p data-testid="pairing-expired" className="text-sm text-warning">
              That code has expired. Show a new one when the phone is ready.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void ask()}
            disabled={asking}
            className="self-start rounded-xl bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:opacity-50"
          >
            {asking ? "Asking the hub…" : expired ? "Show a new code" : "Show a pairing code"}
          </button>
        </>
      ) : (
        <>
          <div className="self-start rounded-xl bg-white p-3">
            <QrCode
              value={pairingUrl(origin, ticket.code)}
              label="Pairing code. Scan it with the phone you want to pair."
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">Live</Badge>
            <span data-testid="pairing-countdown" className="text-sm text-muted">
              This code stops working in {left} second{left === 1 ? "" : "s"}.
            </span>
          </div>
          <p className="text-sm text-muted">
            Scan it with the phone&rsquo;s camera. The first phone to use it is paired and
            the code is spent — if anyone else saw it, it is already worthless.
          </p>
          {isLoopbackOrigin(origin) ? (
            // The QR would scan perfectly and then fail on the phone, which is
            // the most confusing way for this to go wrong.
            <p data-testid="pairing-loopback" className="text-sm text-warning">
              You are viewing this hub at an address only this machine can reach, so the
              code points somewhere the phone cannot follow. Open the dashboard at the
              address the phone will use, then show a code.
            </p>
          ) : null}
        </>
      )}

      {refused ? (
        <p data-testid="pairing-refused" className="text-sm text-danger">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
