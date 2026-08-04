# How a stranger connects

This is a ruling, not a build. It says how the desktop service reaches a client
that is not on this machine — or rather, how it does not, and what sits above it
that does. Nothing here is implemented today, and the sections named "what this
means for the daemon" are all some version of *nothing*.

The daemon is the thing behind the Unix socket. It is local, it is `0600`, and
that is the entire reason the guarantees below the socket keep their meaning.
This document is about the layers that will eventually sit above it.

## The model

Someone who wants to use this runs the desktop software. The desktop software is
the service in this repository — the daemon that speaks to the accessibility
bus, and an installer that puts it on the machine and keeps it running. What we
ship is that installer. What we host is the client.

The client connects to the user's own desktop service, not to ours. It can reach
that service directly when it is on the same network, or through us when it is
not. Think Plex: your media lives on your machine, their servers help your phone
find it, and the bytes do not pass through them unless your router makes them.

The alpha that exists today needs no account. A hostname, a token, and a
tailnet are enough. That is not a shortcut or a Tailscale commitment — it is the
evidence for the rule that the account service is optional by construction.
When the direct path works without one, the account service is a convenience,
not a dependency.

## How a client reaches its server

Three tiers, in the order a sane design reaches for them.

**Tier 1 — local, direct.** The client and the server are on the same LAN. A
wildcard certificate (`*.<account-id>.<our-domain>`) and DNS that resolves names
like `192-168-1-7.<account-id>.<our-domain>` to the private address. No traffic
passes through us; we hand out a name and a certificate, and the connection is
theirs. `*.plex.direct` is the precedent; `tlsmy.net` is an open
reimplementation of the same idea. The failure mode is narrow: only certificate
*renewal* stops when our infrastructure is down, not the product. The known
caveat is that some routers' DNS rebinding protection blocks public names that
resolve to private addresses — Plex has documented this for years, and it is a
property of the router, not of the design.

**Tier 2 — remote, direct.** The client is off-network but the server's router
allows a path. UPnP or a manual port forward. The traffic still does not pass
through us.

**Tier 3 — remote, relayed.** Carrier-grade NAT, the case where neither of the
above is possible. This is the third answer, not the first. The relay is a dumb
pipe that we cannot read — safer than a hole in somebody's router, not more
dangerous than one.

## The five constraints

These are constraints on the layers above the daemon, not components of it.

**1. The relay holds no key.** Encryption is end-to-end between a client and its
own server. The relay moves bytes it cannot read. This is a design constraint on
the relay component (#34's one-server-many-clients shape), not something the
daemon enforces or needs to know about.

**2. The account finds, never carries.** The account service helps a client
discover its server. It never carries the connection. The acceptance test is a
firewall: block the account service at the network boundary and drive the
desktop anyway. If the desktop stops working, the account service was carrying
traffic it had no business carrying.

**3. TLS on day one.** A browser will not hand out a camera or a microphone over
a connection that is not secure — `navigator.mediaDevices` is `undefined`
outside a secure context, and it fails in a way that reads like our bug rather
than like a browser policy. Whatever reaches the client ships TLS from its first
commit. The alpha's path is a Tailscale Let's Encrypt certificate, the server
bound to localhost, and `tailscale serve` in front — which is Tailscale's own
guidance for exactly this.

**4. No cloud-only configuration.** The daemon starts, runs, and does its work
with no cloud dependency. Provider keys — if any — live on the user's machine,
never on our infrastructure. A configuration that only works because our servers
are up is a configuration that stops working when they are not, and that is not
the product.

**5. The pairing shape.** A phone does not type a sixty-character string. The
phone generates the keypair and sends the public half; the desktop shows a QR
code encoding the address and the key over typed strings, and the phone reads
it. The desktop app lists every paired device with a revoke button, so a lost
phone is a two-second fix rather than a credential rotation. This is the one
genuinely new design piece — the rest of the constraints follow from what the
daemon already is.

## What this means for the daemon

Nothing. The daemon is the local service behind the Unix socket. It does not
open a network port, it does not speak to an account service, it does not hold
pairing keys. The constraints above describe layers that sit above it and speak
to it the same way every client does: over the socket, one connection per agent,
with identity the server issued and permissions filed under that identity.

When those layers are built — the reshape in #31, the client library it
extracts, the PWA in #35 — this document is the boundary they must not cross.

## Acceptance criteria for the layers this constrains

Not built here. Recorded so that the issues that do build them inherit the test.

- **#35 (the PWA)** ships TLS from its first commit, and ships the pairing and
  revoke flow described above. A paired device can drive the desktop; a revoked
  one cannot.
- **The account service, if it is built**, passes the firewall test: block it,
  and the desktop is still drivable through a direct path.

## Two questions that are not engineering's to answer

These are recorded here so they are not rediscovered, and left open because they
are product decisions, not technical ones.

- **Does the account service run from the beginning, or is it added later?** The
  alpha proves the direct path needs no account. Whether to build the account
  service before or after that proof is settled is a question about when, not
  whether, and it belongs to the person deciding the roadmap.

- **Who pays for the bytes?** Desktop control is chattier than video is bursty,
  and a relay that cannot read the traffic still moves it. The economics of the
  relay tier are unsettled, and they are not settled by this ruling.
