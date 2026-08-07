"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { redeemTicket, type PairedCredential } from "@/lib/hub";
import { readPairingCode, storeCredential } from "@/lib/pairing-store";

/**
 * Where the QR lands: the phone's side of the pairing ceremony.
 *
 * The code arrives in the URL fragment, which browsers never send to a server,
 * so it reaches this page without passing through an access log on the way. It
 * is read once, spent once, and stripped from the address bar immediately —
 * leaving it there would put a credential in the phone's history and in every
 * screenshot of this page.
 *
 * Redemption is deliberately not automatic on arrival. A URL that pairs a
 * device merely by being opened is a URL that pairs a device when a chat app
 * fetches a preview of it. The person taps, and the tap is what spends the
 * code.
 */

/** What the phone calls itself when the person does not rename it. */
const DEFAULT_LABEL = "My phone";

type State =
  | { kind: "ready"; code: string }
  | { kind: "working" }
  | { kind: "paired"; credential: PairedCredential }
  | { kind: "refused"; detail: string }
  | { kind: "no-code" };

export default function PairPage() {
  const [state, setState] = useState<State>({ kind: "no-code" });
  const [label, setLabel] = useState(DEFAULT_LABEL);

  useEffect(() => {
    const code = readPairingCode(window.location.hash);
    if (code === undefined) {
      setState({ kind: "no-code" });
      return;
    }
    // Out of the address bar before anything else happens: the code is live
    // until it is spent, and the history entry would outlive it.
    window.history.replaceState(null, "", window.location.pathname);
    setState({ kind: "ready", code });
  }, []);

  const pair = useCallback(async (code: string) => {
    setState({ kind: "working" });
    const answer = await redeemTicket(code, label.trim() || DEFAULT_LABEL);
    if (answer.kind === "unreachable") {
      // The code is spent either way — a failed redemption does not get a
      // second try with the same code, and saying so is kinder than a retry
      // button that always fails.
      setState({ kind: "refused", detail: answer.detail });
      return;
    }
    storeCredential(answer.data);
    setState({ kind: "paired", credential: answer.data });
  }, [label]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-foreground">Pair this phone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.kind === "no-code" ? (
            <p className="text-sm text-muted">
              This page needs a pairing code, and there is none in the link that opened
              it. On the machine running the hub, open Devices and show a pairing code,
              then scan it with this phone.
            </p>
          ) : null}

          {state.kind === "ready" ? (
            <>
              <label className="flex flex-col gap-1 text-sm text-muted">
                What should this phone be called?
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  className="rounded-xl border border-border bg-well px-3 py-2 text-foreground"
                />
              </label>
              <p className="text-xs text-muted">
                This name is the only thing this phone tells the hub about itself.
              </p>
              <button
                type="button"
                onClick={() => void pair(state.code)}
                className="rounded-xl bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25"
              >
                Pair this phone
              </button>
            </>
          ) : null}

          {state.kind === "working" ? (
            <p className="text-sm text-muted">Pairing…</p>
          ) : null}

          {state.kind === "paired" ? (
            <>
              <p className="text-sm text-success">
                Paired. This phone is now {state.credential.label} on the hub&rsquo;s devices
                list.
              </p>
              <p className="text-xs text-muted">
                Add this page to your home screen to use it like an app. To undo this,
                remove the device from the Devices page on the machine itself — not from
                here, because a phone that was lost cannot be the thing that revokes it.
              </p>
            </>
          ) : null}

          {state.kind === "refused" ? (
            <p className="text-sm text-danger">{state.detail}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
