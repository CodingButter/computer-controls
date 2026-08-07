# Roadmap

Work is tracked on the [Semantic Desktop Control](https://github.com/users/CodingButter/projects/12)
board. This file is the ordering and the reasoning; the issues carry the rulings and the acceptance
criteria.

The rule the whole roadmap obeys: **a semantic desktop, never a remote shell.** Every capability
added here is addressed by identity — an application id, an element id, a named action — and never
by a command line or a screen coordinate.

## Shipped

| Segment | What it delivered | PR |
| --- | --- | --- |
| 1 — foundation and protocol | A newline-framed JSON-RPC service over a private unix socket, a stable element registry, bounded inspection, and a frozen schema that generates both validators | [#1](https://github.com/CodingButter/computer-controls/pull/1) |
| 2 — acting and delta signals | Focusing, invoking, writing, batching and waiting; a delta engine that says what changed and who caused it; a signal provider that pushes a change into a model's context unasked | [#2](https://github.com/CodingButter/computer-controls/pull/2) |
| 3 — coverage and security | A measured compatibility matrix, paced typing and offset-addressed editing, consent scoped by operation class under a configured ceiling, redaction at the value egress, and an append-only audit log | [#3](https://github.com/CodingButter/computer-controls/pull/3) |

## Next — Segment 4: documentation and ship

The service works; nobody outside this repository can yet use it without reading the source.

- [#17](https://github.com/CodingButter/computer-controls/issues/17) — documentation written from the shipped code
- [#18](https://github.com/CodingButter/computer-controls/issues/18) — measure the token cost against screenshots and coordinates
- [#11](https://github.com/CodingButter/computer-controls/issues/11) — prove a deletion is reported as a deletion, live

## Then — user presence and takeover

The single failure mode that would make this unusable: the person at the keyboard reaches for a
field the agent is working in, and the agent keeps typing.

- [#4](https://github.com/CodingButter/computer-controls/issues/4) — the user taking focus stops the agent mid-sentence

## Then — multi-agent

Everything here follows from one principle, stated by the user who has to live with the result:

> Never give the key to the agent or they'll try it on every door.

- [#7](https://github.com/CodingButter/computer-controls/issues/7) — the agent holds no key; the client holds the door
- [#9](https://github.com/CodingButter/computer-controls/issues/9) — scope anchors: permission hangs on a place in the tree
- [#5](https://github.com/CodingButter/computer-controls/issues/5) — per-client attention: which applications, how deep
- [#6](https://github.com/CodingButter/computer-controls/issues/6) — contention: an element is owned while it is written
- [#8](https://github.com/CodingButter/computer-controls/issues/8) — approval criteria: proof the agent cannot author
- [#10](https://github.com/CodingButter/computer-controls/issues/10) — scope chooses the brain
- [#12](https://github.com/CodingButter/computer-controls/issues/12) — trade-offs that stop being acceptable with co-tenants

## Then — one server, many clients

The deployment shape the rest of the work assumes, settled in
[#34](https://github.com/CodingButter/computer-controls/issues/34).

A **server** is a machine being controlled: this daemon, an agent layer above it, a gateway above
that — one per machine. A **client** is anything holding a server URL and a credential, and there
are as many as there are surfaces: browser, phone, laptop, whatever comes next. The socket does
not change. It stays local, `0600`, and nothing network-facing ever speaks to the desktop
directly, which is what lets consent classes, element ownership, the takeover guard, value
redaction and the audit log keep meaning exactly what they mean today. A rule enforced anywhere
above this is a rule with a way around it.

The expensive detail is one line long and lives in `transport.py`: the server layer opens **one
connection per agent**, never one for the whole server. Identity, grants, element ownership and
disconnect cleanup all key off the connection, so agents sharing one become one client in four
places at once.

- [#31](https://github.com/CodingButter/computer-controls/issues/31) — the reshape: a core, an agent layer, and many clients
- [#35](https://github.com/CodingButter/computer-controls/issues/35) — the first client, and it is not this plugin *(the phone pairs and installs; see `docs/11-the-phone.md`)*
- [#36](https://github.com/CodingButter/computer-controls/issues/36) — a stranger connects: installer, hosted client, account

## Known limits

Not defects. Measured facts about what each toolkit publishes, kept open because a client author
needs to know them and because the tier ladder exists precisely for these.

- [#13](https://github.com/CodingButter/computer-controls/issues/13) — our depth ceiling is the real limit; Electron is not opaque
- [#14](https://github.com/CodingButter/computer-controls/issues/14) — Zoom exposes one interface and no `Collection`
- [#15](https://github.com/CodingButter/computer-controls/issues/15) — the accessibility layer cannot see a GTK4 gutter

## Later

- [#16](https://github.com/CodingButter/computer-controls/issues/16) — port the backends to Windows

Deliberately parked, and cheaper than it sounds: everything platform-specific lives under
`comcon/desktop_service/backends/`, and a test fails if a toolkit import appears above it.
