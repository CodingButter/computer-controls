# Distribution and the dashboard

This is a ruling, not a build. It fixes the shape of what ships: one package,
three layers, three depths of user, and a plugin surface with a quality bar.
The issues that build these pieces (#81 the hub, #82 provider login, #83 the
voice lane, #35 the PWA, #31 the reshape) inherit this document as their
boundary. Doc 06 remains the law for anything that leaves the machine; nothing
here weakens it.

## The ruling in one paragraph

We ship one Debian package. It installs three things: the desktop daemon as a
systemd user service, a headless Mastra Code runtime, and a local web hub that
is both the dashboard and the first client. The hub serves the same origin to
the desktop browser and to a phone paired by QR code. There is no Electron
shell, no bundled Chromium, and no cloud account required to function. Think
Plex: the software lives on your machine, our servers may later help a phone
find it, and the bytes are yours.

## The three layers

**The daemon.** The Python service in this repository, installed as a systemd
user unit bound to the graphical session. It owns the accessibility bus, the
consent ceiling, the send gate, presence, and the audit log. It listens on a
`0600` Unix socket keyed by schema digest and nowhere else. It must outlive any
client window; a dashboard tab closing must never cost the user their desktop
service. The daemon learns nothing from this document. That is the point.

**The runtime.** A headless Mastra Code process, the same engine Factory rides.
It loads our desktop plugin, memorease, and whatever else the plugin surface
below admits. Model packs, provider credentials, and agent instructions live
here. The hub talks to the runtime; the runtime talks to the daemon over the
socket like any other client, holding an issued identity and a granted scope.

**The hub.** A local Next.js server bound to localhost with TLS in front, per
doc 06 constraint 3. It is the dashboard (setup, settings, model packs, the
audit feed, pairing and revocation) and it is the first client (a chat you can
talk to, voice first). One origin serves the desktop browser and the phone.
The PWA of #35 is this hub reached from a phone, not a second product.

## Why not Electron

Recorded so the argument is not rehad every quarter.

- Every native capability already lives behind the daemon socket. A Chromium
  wrapper adds no reach, only weight.
- An app that carries the daemon inverts ownership: close the window, lose the
  desktop service, or grow tray hacks to pretend otherwise. The systemd unit
  owns the daemon's lifetime; windows are just views.
- `apt upgrade` beats a bundled updater, and roughly two hundred megabytes of
  duplicate browser per install is a tax with no product behind it.
- Our own client would otherwise become a row in our own compatibility matrix,
  a nine-hundred-node Electron tree we would be testing ourselves against.

The recorded escape hatch: if a real shell is ever needed (a native global
hotkey is the only case a browser cannot cover), the answer is Tauri, and it
wraps the hub rather than replacing it.

## The package

One `.deb`, installable with `apt`. It carries:

- the daemon and its Python environment
- the headless runtime and the desktop plugin
- the hub and its built assets
- the systemd user units and an installer that enables them for the installing
  user's graphical session

First run opens the hub, which walks setup: sign in to your own model
accounts (the Factory way: paste-code for Anthropic, device code for OpenAI;
tokens never leave the machine), pick a depth, pair a phone if you want one.
No account with us exists in this flow. Doc 06's firewall test applies from
the first release: block everything that is not local and the product still
works.

## Three depths, one object model

Easy, Standard, and Advanced are lenses over one configuration object, never
three UIs and never three products.

- **Easy** ships opinionated defaults: a persona, a preset pack, and the feed
  as the centerpiece: everything the agent did in your name, and the approval
  trail for anything that left the machine.
- **Standard** exposes provider keys, local models, and per-application
  permissions.
- **Advanced** exposes instructions, new agents, element-level grants, and
  review criteria.

The acceptance rule: a user who grows out of Easy keeps their configuration.
If moving depths ever migrates or resets state, the lenses have silently
become products and this ruling is being violated.

## The plugin surface

The desktop layer ships two ways: inside the deb, and as a standalone Mastra
Code plugin for people who already run the harness. Same code, same socket,
same ceiling.

In the product, every community Mastra Code plugin is loadable. On top of that
sits a curated registry of approved plugins, because this product's pitch is
what the agent provably cannot do. The registry is a quality bar, the way an
app store is, not a wall:

- Approved plugins install from the dashboard with one click and are the only
  ones Easy mode surfaces.
- Standard and Advanced can load anything, behind a plainly worded warning
  that an unreviewed plugin runs with the runtime's authority.
- Approval is a review with published criteria, and revocation is a published
  list. What was approved and when is auditable, like everything else here.

## The credential vault

Designed, not built; recorded here so the client issues inherit it. The
dashboard keeps a local secure store for the user's application credentials.
A model references a secret by name only; the daemon queries the vault and
injects the value into the target field at the `holds.for_write` choke point.
The value never enters model context, never appears in the audit log, and
never leaves the machine. This is the write-side twin of the shipped egress
redaction: the agent logs in as you without ever possessing your password.

## Voice

Voice is a first-class feature of the hub, not an accessory. The path is
Mastra's own: the realtime speech package for the conversation loop and the
non-realtime package for transcripts and read-back, with the user's own OpenAI
account as the mouth and ears and the pack's model as the brain (#83). The
browser side requires a secure context, which is why doc 06 puts TLS on day
one rather than on the roadmap.

## What this means for the daemon

Nothing, again. The daemon does not know it is being distributed. It does not
open a port, hold a pairing key, store a provider token, or serve a page. The
hub and runtime speak to it over the socket with issued identities, granted
scopes, and the same ceiling as every stranger. Any build that finds itself
teaching the daemon about packaging has crossed the boundary and should stop.

## Acceptance criteria the builds inherit

- **The deb** installs on a clean Ubuntu 24.04, and after first-run setup the
  daemon survives every hub restart and every closed tab.
- **The hub** passes doc 06's firewall test on day one.
- **Depth switching** is provably lossless: configure in Easy, switch to
  Advanced and back, diff the configuration object, expect no change.
- **The registry** cannot be bypassed silently: loading an unapproved plugin
  is possible in Standard and Advanced and is recorded, never quiet.
- **The vault**, when built, is proven by the same shape as the redaction
  proofs: a secret typed by the agent is absent from model context, absent
  from the audit log, and present in the target field.
