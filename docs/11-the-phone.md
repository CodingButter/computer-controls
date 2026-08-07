# The phone

How a phone becomes a client of the hub: what it installs, how it is paired,
and how it is taken away again. This is a build, not a ruling — everything
described here is in the tree, and the tests named at the bottom hold it.

Doc 10 settled the shape: the phone is not a second product. It is the hub,
reached from a phone. There is one origin, one credential lane, one set of
routes. Nothing in this document is a server the phone talks to instead of the
hub.

## What the phone installs

The dashboard is a PWA. It carries a manifest, maskable icons and a service
worker, so a phone can add it to the home screen and open it without browser
furniture.

The service worker caches the shell — the HTML, the CSS, the icons — and
nothing else. Every live answer is exempt by path: `/api/*` and `/events` are
returned early, untouched, before the cache is ever consulted. A cached
device list would be a page confidently describing a desktop as it was ten
minutes ago, which is worse than a page that admits it cannot reach the hub.

## Pairing

Pairing is a ceremony with two doors that are deliberately not the same door.

**The mint is local.** `POST /api/pairing/ticket` is refused unless the kernel
says the caller is on this host. The consent story is that someone sitting at
the machine pressed a button and a code appeared on their screen; a mint
reachable from the network would be a lock handing out its own keys. The
button lives in the Devices page's existing "Pair another device" card — the
card that until now had a reason and nothing to press.

**The ticket is a credential on a screen**, and is treated as one. It lives
two minutes, works exactly once, and exists only in memory. It is consumed
before the caller is told it worked, so a second request racing the first
finds nothing rather than a second grant — a QR photographed over a shoulder
is worthless the moment the intended phone has used it. Only one is ever
outstanding: showing a new code retires the old, because a hub with a queue of
live codes is a hub where a press three minutes ago is still an open door. The
card counts down, so an expired code is replaced rather than silently failing
on the phone, which is the one place that cannot explain what went wrong.

**The redeem is the one route that answers a stranger.** `POST
/api/pairing/redeem` must answer a caller holding no credential, because that
is what bootstrapping means. It is safe because of what the ticket is, not
because of who is asking. It is also the only route in the hub that ever
returns a device secret, and it returns it exactly once, to the caller that
spent the ticket.

The code reaches the phone in the URL fragment, which browsers do not send to
servers — it arrives without passing through an access log. The page strips it
from the address bar before anything else, and redemption waits for a tap: a
URL that pairs a device merely by being opened is a URL that pairs a device
when a chat app fetches a link preview.

## Revoking

A paired phone appears on the Devices page as the first legitimately removable
row. Removing it revokes the credential, and the `/events` door stops opening
for it — the door reads the credential file on every attempt rather than
caching it at boot, so revocation takes effect on the next connection instead
of the next restart. `client/src/events/socket.test.ts` holds this directly:
a credential that opened the door a moment ago is refused after revocation,
and revoking one device leaves the others paired.

Revocation is done from the machine, never from the phone. A lost phone cannot
be the thing that revokes itself.

## The front door, and the one thing it must not forward

The hub binds `127.0.0.1` and serves plain HTTP. It does not grow a network
bind for this — a phone reaches it through a TLS terminator in front, which is
also what satisfies doc 06's day-one TLS and what a browser requires before it
will hand out a microphone or allow an install.

That proxy needs one deliberate piece of configuration, and it is the sharpest
thing on this page. **Locality is read off the socket**, which is the only
account of a peer that a caller cannot write — but a proxy makes every request
arrive from loopback. It must therefore not forward the local-only routes:

| Path | Forward to the phone? |
| --- | --- |
| `/api/pairing/redeem` | Yes — this is how a phone pairs. |
| `/events` | Yes — with the device credential subprotocol. |
| Static assets, `/pair`, the dashboard pages | Yes. |
| `POST /api/pairing/ticket` | **No.** Forwarding it lets the network mint its own pairing codes. |
| `DELETE /api/pairing/devices/:id` | **No.** |

This is the same exposure the `/events` door already named: a proxy in front
of a loopback hub is a decision someone made deliberately, and no check inside
the process survives it. The difference is that #35 is the reason a proxy gets
installed at all, so the requirement is written down here rather than left to
be rediscovered.

## What holds it

| Test | Holds |
| --- | --- |
| `client/src/pairing/tickets.test.ts` | Expiry, single use, one outstanding ticket, identical refusals. |
| `client/src/pairing/routes.test.ts` | Mint refused over the network, secret returned once and from no other route, revocation local-only. |
| `client/src/events/socket.test.ts` | A paired device is admitted; a revoked one is not. |
| `client/src/ui.test.ts` | The manifest is typed so a browser reads it; the service worker exempts every live path. |
| `dashboard/src/app/devices/devices.test.tsx` | The card shows no code until asked, a paired phone is named only by what it called itself, and the page still names nothing about the machine. |
| `dashboard/src/app/pair/pair.test.tsx` | The phone's side: the code is read from the fragment and never from the query, and the credential is spelled the way the door parses it. |
