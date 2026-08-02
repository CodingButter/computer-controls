# Semantic Desktop Control Protocol v1.0

**Frozen.** `schema.json` is the single source of truth; both halves generate from it and
neither defines a message shape of its own. A golden copy lives at `golden/v1.0.schema.json`
and `service/tests/test_protocol_compat.py` fails the build on any breaking change.

Transport is newline-framed JSON-RPC 2.0 over a Unix socket — one JSON object per line, one
response per request, ids correlated by the client. The socket is per service instance, not
per client; several clients share one instance and one element namespace.

This document states the rules that are *not* expressible in JSON Schema. They are normative:
"must" means a conforming service has a bug otherwise.

## Breaking versus additive

Additive, allowed forever at 1.x:

- a new method
- a new **optional** request field
- a new response field
- a new enum member in a *response*-only position

Breaking, requires 2.0:

- removing or renaming a method or field
- narrowing a type or tightening a constraint
- changing an error code's meaning or removing one
- **adding a required request field, or promoting an optional one to required**

That last one is the trap the compatibility suite exists for. It looks additive — nothing was
removed — but every existing client breaks at once. Segment 3 adds permission enforcement, and
the temptation there is a mandatory confirmation parameter. That is why `confirm` is already in
the schema as optional: a method that requires confirmation and does not receive it fails with
`PERMISSION_DENIED`, which is a *runtime* refusal, not a schema change.

## Element ids

An id is minted the first time the service describes an element and is derived from the
element's address on the accessibility bus — the pair of bus name and object path, hashed.
Format is `el-`, `win-` or `app-` followed by twelve hex characters.

- **An id is valid for the lifetime of the service instance.** It survives client restarts,
  because it belongs to the service rather than to whoever asked first. A second client can use
  an id the first client obtained.
- **An id is never reused for a different element.** Derivation is from the address, and the
  accessibility bus does not recycle a path onto a different object within a session.
- **An id alone cannot reach an element.** AT-SPI offers no way to turn an address back into a
  live object, so the service holds the objects it has handed out. This is an implementation
  fact with a protocol consequence: ids from a *previous* service instance are meaningless, and
  the service must answer `ELEMENT_NOT_FOUND` for them rather than guessing.

`ELEMENT_NOT_FOUND` and `ELEMENT_REFERENCE_STALE` are different answers to different
questions. Not-found means the service has never heard of this id. Stale means it has, and the
thing it named is no longer that thing.

## Staleness

Every id carries a **fingerprint** of what the caller was shown: role, name, position among
siblings, and a digest of the parent. On use, the service re-derives the fingerprint from the
live element and compares.

`ELEMENT_REFERENCE_STALE` is raised when:

1. the element no longer exists, or
2. any fingerprint component differs from what was recorded.

It carries `elementId`, `observedAtRevision`, `currentRevision`, a `changed` map naming each
differing component with its old and new value, and `newElementId` when the same element was
re-found by fingerprint elsewhere.

The rule behind it: **the service must never act on a different element because it resembles the
one that was asked for.** Three buttons named "Close Tab" differ only by sibling position; a
service that ignored position would close whichever it found first. Resolution is the caller's
job — re-query, then use the new id. Re-resolution **mints a new id**; the stale one stays
stale forever rather than being quietly rebound.

The fingerprint's name is the name that was *emitted*, after the value-egress point. If a later
segment turns on redaction, references stay valid instead of all going stale at once.

## Revisions

The service holds a monotonic, session-scoped counter. It increments when observed desktop
state changes — an element's fingerprint differs from the recorded one, elements appear, or
elements disappear. **Re-observing an unchanged desktop does not increment it.** That property
is what makes it usable as a change detector rather than a call counter.

Every response carrying elements carries the revision they were observed at. A revision range
is the addressing unit for the delta engine and for causal attribution: an action records the
range it spanned, and changes inside that range can be attributed to it.

Revisions are meaningless across service instances and are never persisted.

## Capability negotiation

`getDesktopCapabilities` **probes**. It does not read a setting and report it. On this
development machine `org.gnome.desktop.interface toolkit-accessibility` reads false while the
accessibility bridge is fully functional, so the only honest answer comes from enumerating the
desktop and seeing whether anything comes back.

The tier vocabulary is **complete at freeze**, including tiers that are deliberately not
implemented. `app-native`, `vision` and `raw-input` are reported `available: false` with a
reason. This is the seam: when browser integration or a compositor backend lands later, it
fills a declared tier rather than widening a frozen enum. Same reasoning for the `backend`
field on an element and for `fallbacksUsed`.

An unavailable tier is **always reported with a reason**, never omitted. A missing tier and a
tier that is missing *for a stated reason* are different pieces of information, and the second
is the one a caller can act on.

## Observation mode

Cadence is protocol, not an internal detail, because **the client owns it and the service does
not**. Most events that justify watching harder — a file changing, a transcript arriving, a
timer expiring, an agent starting work — are invisible from inside the desktop service. It
cannot make the decision, so it accepts the instruction.

`setObservationMode` sets the mode and its timings. Every mode-aware response reports the
current mode so a client never has to assume.

`idle` **does not mean not watching.** AT-SPI is genuinely event-driven: window creation,
destruction and focus changes are subscribed to, and those subscriptions stay live in both
modes. What the mode changes is the *reconciliation sweep* — the periodic pass that catches
what the event stream dropped. A service that implemented idle mode by walking the
accessibility tree less often, rather than by sweeping less often, has misunderstood this
completely and will both cost more and notice less.

## Attention

Attention is what a client is looking at. Permission is what it may touch. They share a
vocabulary — both talk about applications — and keeping them apart is the whole design.

`setAttention` is **per connection**, keyed by the identity the transport mints rather than by
any name in the request body, so two agents sharing one service can watch different things and
neither can adopt the other's view. It declares the whole attention: a field left out takes its
default, and a call with no fields returns the connection to the whole desktop. An undeclared
connection attends to everything, which is why nothing that predates this method notices it.

Attention can only **subtract**. The consent ceiling filters first and produces a set attention
narrows further, so naming a walled-off application stores the name and shows nothing — there
is no ordering here in which asking reveals whether the application is even running.

Naming applications also lifts the inspection depth ceiling. The flat cap exists because a walk
that starts at the desktop is unbounded in practice, not because twelve levels means anything;
a walk that starts inside one named application is bounded by the node budget, which is the
real cost. That is what makes content sitting below a dozen layers of scaffolding — an editor's
document text — reachable without drilling to an anchor first.

## Errors

The top-level JSON-RPC `code` stays a reserved number. The domain code lives in `data.code`,
drawn from the closed vocabulary in the schema, with structured context in `data.detail`.

`PERMISSION_DENIED` and `SESSION_EXPIRED` are separate on purpose: "you may not do this" and
"you may, but ask again" call for different client behaviour. Both are declared now and
enforced later.

## Values

Every name and value that leaves a backend passes through a single egress point. In 1.0 it is a
pass-through with a policy hook. A later segment installs redaction there. The protocol
consequence is that a value's absence or masking is a service-side guarantee, not something a
caller is trusted to arrange, and no future method may return a value that bypasses it.

## What this protocol does not have

No coordinates in any request. No screenshot or screen-capture method. No synthetic pointer or
key event. `bounds` is reported for orientation and is not accepted as input anywhere. This is
a design constraint, not an omission to be filled in later.
