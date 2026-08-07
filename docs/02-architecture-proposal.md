# Architecture: why a plugin, not an MCP server

This document records the architectural decisions behind `computer-controls` and
the reasoning that makes each one load-bearing. Every claim cites a file and
line, a test name, or a protocol rule. A claim that cannot be so cited is deleted
rather than softened.

The single decision the rest of this document explains: **the desktop agent is a
Mastra Code plugin, not an MCP server.** Everything else — the transport, the
element identity, the revision counter, the push lane — follows from that choice
or from the nature of AT-SPI2.

---

## 1. The load-bearing decision: push, not pull

MCP (Model Context Protocol) is request/response. A model asks for something and
receives an answer. It never receives anything it did not ask for. That is the
right model for a static tool surface — "list the files," "read this file" —
where the world does not change between calls.

A desktop is not static. A window closes; focus moves; a value changes; a timer
fires. Under pure request/response, the model discovers these things only on its
next tool call, and only if it happens to ask the right question. A change that
the model needed to know about *now* — the window it was working in vanished —
arrives whenever the model next polls, which might be never.

The capability the whole project exists for is stated in one comment
(`plugin/src/signals/desktop-signal-provider.ts:1-8`):

> Everything else in this plugin is pull — the model asks, the service answers.
> This is the one path where a change on the desktop reaches the model without
> anybody having called a tool. That is the capability the whole project exists
> for.

A Mastra Code plugin can declare a **signal provider** — a source that pushes an
unrequested delta into the model's context — and an **input processor** that runs
on every turn. An MCP server can declare neither. The plugin shape exists
precisely because request/response is insufficient for a world that changes on
its own, and the push lane is the feature that cannot be built inside MCP's
model.

ROADMAP segment 2 shipped the signal provider explicitly: "a signal provider
that pushes a change into a model's context unasked" (`ROADMAP.md:16`).

---

## 2. Transport: one Unix socket, newline-framed JSON-RPC

The wire protocol is newline-framed JSON-RPC 2.0 over a Unix socket — one JSON
object per line, one response per request, ids correlated by the client
(`protocol/README.md:7-9`). The socket is per service instance, not per client;
several clients share one instance and one element namespace
(`protocol/README.md:8-9`).

The socket stays local, `0600`, and nothing network-facing ever speaks to the
desktop directly (`ROADMAP.md:56-59`). This is not a configuration choice; it is
the boundary that lets consent classes, element ownership, value redaction, and
the audit log keep meaning. A rule enforced above the local socket is a rule
with a way around it; a rule enforced at the socket has no way around it.

The schema is **frozen at v1.0** (`protocol/README.md:1-5`). `schema.json` is
the single source of truth; both the Python service bindings and the TypeScript
plugin bindings generate from it, and neither defines a message shape of its
own. A golden copy lives at `golden/v1.0.schema.json` and
`comcon/tests/test_protocol_compat.py` fails the build on any breaking change.
The generator stamps a 16-character digest (`bfa45250563894d0`) into both
generated files so a client and a daemon can detect a version mismatch at
handshake time — not assumed, compared (`plugin/src/index.ts:89-106`).

---

## 3. Element identity: derived, not assigned

An element id is minted the first time the service describes an element and is
derived from the element's address on the accessibility bus — the pair of bus
name and object path, hashed (`protocol/README.md:36-40`). The format is `el-`,
`win-`, or `app-` followed by twelve hex characters. Three properties follow
(`protocol/README.md:42-50`):

1. **An id is valid for the lifetime of the service instance.** It survives
   client restarts, because it belongs to the service rather than to whoever
   asked first. A second client can use an id the first client obtained.
2. **An id is never reused for a different element.** Derivation is from the
   address, and the accessibility bus does not recycle a path onto a different
   object within a session.
3. **An id alone cannot reach an element.** AT-SPI offers no way to turn an
   address back into a live object, so the service holds the objects it has
   handed out. This is an implementation fact with a protocol consequence: ids
   from a *previous* service instance are meaningless, and the service must
   answer `ELEMENT_NOT_FOUND` for them rather than guessing.

`ELEMENT_NOT_FOUND` and `ELEMENT_REFERENCE_STALE` are different answers to
different questions (`protocol/README.md:52-54`): not-found means the service has
never heard of this id; stale means it has, and the thing it named is no longer
that thing.

---

## 4. Staleness: fingerprints, not resemblance

Every id carries a **fingerprint** of what the caller was shown: role, name,
position among siblings, and a digest of the parent. On use, the service
re-derives the fingerprint from the live element and compares
(`protocol/README.md:56-69`).

The rule behind it (`protocol/README.md:71-75`):

> The service must never act on a different element because it resembles the one
> that was asked for.

Three buttons named "Close Tab" differ only by sibling position; a service that
ignored position would close whichever it found first. Resolution is the
caller's job — re-query, then use the new id. Re-resolution **mints a new id**;
the stale one stays stale forever rather than being quietly rebound.

The fingerprint's name component is the *emitted* name — the one that has passed
through the value-egress point — not the raw name (`protocol/README.md:77-78`).
If a later segment turns on redaction, references stay valid instead of all
going stale at once, because the name the registry remembered and the name it
now sees are the same post-redaction name.

---

## 5. Revisions: a change detector, not a call counter

The service holds a monotonic, session-scoped counter. It increments when
observed desktop state changes — an element's fingerprint differs from the
recorded one, elements appear, or elements disappear
(`protocol/README.md:82-85`).

**Re-observing an unchanged desktop does not increment it.** That property is
what makes the revision usable as a change detector rather than a call counter.
If every observation bumped the counter, a client asking "what changed?" would
see its own observation as a change, and the delta engine would be useless.

Every response carrying elements carries the revision they were observed at. A
revision range is the addressing unit for the delta engine and for causal
attribution: an action records the range it spanned, and changes inside that
range can be attributed to it (`protocol/README.md:87-89`). Revisions are
meaningless across service instances and are never persisted
(`protocol/README.md:91`).

---

## 6. The push lane: polling a precomputed integer, not a desktop

The signal provider is the one path where a change reaches the model without a
tool call. It is built once at plugin load and shared between the
signal-provider lane and the arming processor — two provider instances would
mean one subscribed provider and one polling provider that never learned a
thread existed (`plugin/src/signals/index.ts:1-7, 19-22`).

The provider polls the service's revision counter over the local Unix socket,
not the desktop. This is deliberate and the reasoning is in the source
(`plugin/src/signals/desktop-signal-provider.ts:10-24`):

The service is genuinely event-driven — AT-SPI events, no polling of the
accessibility tree — and it could push deltas up the socket as JSON-RPC
notifications. It does not, for three reasons:

1. **Each client asks for what changed since its own cursor.** A client that was
   disconnected, slow, or restarted resumes exactly where it left off. Server
   push would have to solve that separately, and would solve it worse.
2. **Delivery becomes idempotent for free.** A change is either past a thread's
   cursor or it is not; no ledger of "have I mentioned this yet" is required.
3. **The cost being avoided is a local Unix-socket round trip against an answer
   the service has already computed.** No model, no tree walk. Polling *the
   desktop* would be indefensible; polling a precomputed integer is not.

The model still gets a push. That is the part that matters.

### Priority routing

Not all changes are equal. `priorityOf` inspects a delta's changes and routes
them (`plugin/src/signals/desktop-signal-provider.ts:81-100`):

- **`window-closed`** is an interrupt-class change. A window disappearing is the
  one structural change a worker cannot discover later without consequence:
  whatever it was about to do in there will fail, and it should hear about that
  now rather than on its next turn. Interrupts travel at `high` priority.
- **Everything else** — a window opened, focus moved, a value changed — is news.
  News travels at `medium` (ambient) priority.
- **`user` attribution** is reserved as an interrupt trigger, because a human
  touching something is not information to be filed but a reason to stop. The
  service presently reports `unknown` rather than guessing, so this path is
  unreachable in production today — but the routing rule is stated now so it
  does not have to be discovered later (`desktop-signal-provider.ts:86-92`).

Priority is not a free parameter. `medium` and `high` honour
`ifIdle: { behavior: 'persist' }` and touch no model when the thread is idle,
while `low` is deferred into a digest whose sender overrides the idle behaviour
and wakes the thread. This is proven against the runtime in
`idle-behavior.gate.test.ts`, not assumed (`desktop-signal-provider.ts:27-33`).
Desktop deltas therefore go out at `medium` or `high`, never at `low`.

### Summary, not payload

What the model receives is a **summary**, not a payload
(`plugin/src/signals/desktop-signal-provider.ts:102-121`). A wall of change
objects in the notification slot would be noise the model cannot act on. The
summary is enough to decide whether to look — "The desktop changed while you
were not looking: window X closed, focus moved to Y" — and the tools already
exist for the detail. If the delta is incomplete (earlier changes were dropped),
the summary says so and names the revision to re-read from.

---

## 7. The arming processor: the turn with no tool call

The push lane needs to know which threads to deliver to. A tool call is not a
reliable signal, because **the turn that matters most for this feature is
precisely the turn where the model called no desktop tool at all**
(`plugin/src/signals/processor.ts:1-8`).

The arming processor is an input processor that runs on every turn. It
contributes nothing to the model's input — it returns the message list it was
handed, untouched. Its whole job is to read the thread identity from the memory
request context and say "this thread exists" to the push lane
(`plugin/src/signals/processor.ts:1-13, 41-53`).

Thread identity comes from the memory request context rather than from
arguments, because `processInput` is handed the context but not the ids. A turn
without memory-backed thread ids simply does not arm; there is nothing to
subscribe and nowhere to deliver (`processor.ts:10-13`).

---

## 8. Deployment shape: one server, many clients

The deployment shape the rest of the work assumes (`ROADMAP.md:48-64`):

- A **server** is a machine being controlled: this daemon, an agent layer above
  it, a gateway above that — one per machine.
- A **client** is anything holding a server URL and a credential: browser,
  phone, laptop, whatever comes next.
- The socket does not change. It stays local, `0600`, and nothing
  network-facing ever speaks to the desktop directly.

The expensive detail is one line long and lives in `transport.py`
(`ROADMAP.md:61-64`): the server layer opens **one connection per agent**, never
one for the whole server. Identity, grants, element ownership, and disconnect
cleanup all key off the connection, so agents sharing one become one client in
four places at once — they would share a permission scope, an attention
declaration, an element hold, and a cleanup boundary, none of which is what
either agent intended.

---

## 9. Attention and permission: same vocabulary, different axes

Attention is what a client is looking at. Permission is what it may touch. They
share a vocabulary — both talk about applications — and keeping them apart is
the whole design (`protocol/README.md:128-131`).

`setAttention` is **per connection**, keyed by the identity the transport mints
rather than by any name in the request body, so two agents sharing one service
can watch different things and neither can adopt the other's view
(`protocol/README.md:132-136`).

Attention can only **subtract**. The consent ceiling filters first and produces
a set; attention narrows that set further. Naming a walled-off application
stores the name and shows nothing — there is no ordering here in which asking
reveals whether the application is even running (`protocol/README.md:138-140`).
This is the property that makes a permission boundary meaningfully a boundary:
the act of asking cannot probe it.

---

## 10. Values: one egress point

Every name and value that leaves a backend passes through a single egress point
(`protocol/README.md:159-164`). In 1.0 it is a pass-through with a policy hook;
segment 3 installed redaction there. The protocol consequence is that a value's
absence or masking is a **service-side guarantee**, not something a caller is
trusted to arrange, and no future method may return a value that bypasses it.

This is why the three-way text verdict — `verified`, `mismatch`,
`unverifiable` — never echoes the raw text back, even on mismatch (see
`docs/01-research-findings.md` §7). The verdict is the whole egress.

---

## 11. What this architecture does not have

No coordinates in any request. No screenshot or screen-capture method at the
*screen* level. No synthetic pointer or key event. `bounds` is reported for
orientation and is not accepted as input anywhere
(`protocol/README.md:166-171`).

This is a design constraint, not an omission to be filled in later. The whole
roadmap obeys one rule (`ROADMAP.md:7-9`):

> A semantic desktop, never a remote shell. Every capability added here is
> addressed by identity — an application id, an element id, a named action — and
> never by a command line or a screen coordinate.

`captureWindow` exists — addressed by window id, so a caller can never ask for
the screen and never receive somebody else's window in the frame
(`capabilities.py:112-178`). But it is the exception that proves the rule: even
the one visual method is identity-addressed, not coordinate-addressed. The
fallback chain to raw input exists as a last resort, reported as unavailable with
a reason (`capabilities.py:112-178`), but the architecture is built so that a
competent semantic layer makes reaching for it rare.
