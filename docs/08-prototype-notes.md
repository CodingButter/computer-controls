# Prototype notes: what proved out, what was harder than expected

This document is written for the next person who has to change something in this
project, not for a reader evaluating whether to adopt it. Every claim cites a
file and line, a test name, or a protocol rule.

---

## 1. The single-thread rule

`Atspi` is not thread-safe, and its event delivery requires a running GLib main
loop. The service fixes one rule and every later phase obeys it
(`backends/loop.py:1-6`):

> one thread owns the loop, and every call that touches the desktop runs on it.

The socket server accepts connections on its own threads and marshals each
backend call to the loop thread with `call_on_loop`, which blocks the calling
thread until the loop produces a result (`loop.py:8-12`).

Later phases — event callbacks, debounce timers, the reconciliation sweep — all
attach to this same loop as GLib sources rather than starting threads of their
own (`loop.py:10-12`). `after(delay_ms, fn)` is how the watcher's debounce and
its reconciliation sweep live on the same thread, instead of on a timer thread
that would have to marshal back anyway (`loop.py:207-238`).

### The default context, not a private one

The loop runs `GLib.MainContext.default()`, not a private context
(`loop.py:62-68`). AT-SPI registers its D-Bus event dispatch on the default
context when it initialises, so a loop running any other context receives no
desktop events at all — and the failure is silent: calls keep working,
subscriptions register successfully, and nothing ever arrives. The code comment
records this cost an hour (`loop.py:63-67`).

### Shutdown releases blocked callers

On shutdown, callers blocked in `call_on_loop` are released with an error
instead of being left to burn their whole timeout (`loop.py:44-48`). A client
waiting fifteen seconds for a service that already stopped learns nothing the
first second could not have told it.

The quit source is attached to the loop's own context, not to the default
context via `GLib.idle_add` — which would mean the callback never runs and
shutdown falls back to the join timeout, a five-second pause on every stop
(`loop.py:122-129`).

---

## 2. Capability probing beats reading settings

The `gsettings` value for `toolkit-accessibility` reads false on machines where
the bridge works perfectly. It is never consulted anywhere in the code
(`backends/atspi.py:193-197`). Probing the bus directly — asking
`org.a11y.Bus` for its address over plain D-Bus — is the reliable test, and it
fails politely via `GLib.Error` instead of aborting the process
(`atspi.py:118-172`).

This lesson generalised into the capability model: unimplemented tiers are
reported unavailable-with-reason, never omitted (`capabilities.py:86-96`).

---

## 3. Depth ceiling is reproducible, not mysterious

The depth ceiling (12 levels, 600 nodes) is not an Electron finding. A walk
repeated at a fixed depth returns the same count on every round
(`docs/07-open-questions.md:52-54`). What looked like "the tree is built while
you walk it" was four ad-hoc scripts with four different depth limits, read as
application behaviour. The instrument's own setting was mistaken for the thing
being measured.

This is recorded in `07-open-questions.md` as a retraction, not buried — because
the same mistake is available to the next person who writes a probe.

---

## 4. Frame actions vs widget actions

A toolkit puts its actions either on the frame, as GTK4 does, or on its widgets,
as Qt does (`docs/07-open-questions.md:111-116`). The probe counts frame actions
and inner-element actions separately for this reason: GTK4 puts the whole
command set on the frame and leaves the element tree nearly empty; Qt does the
reverse (`probe.py:130-162`).

The phrase "Zoom exposes no actions" was wrong — it was said on the strength of
a `0` in the *frame actions* column, without ever asking a single element inside
a window. Zoom has 218 actionable elements and is fully drivable
(`07-open-questions.md:118-126`).

---

## 5. The `--no-live` lane

The test suite has two lanes: a `--no-live` lane that must pass anywhere the
Python typelibraries are importable, and a `--live` lane that exercises the real
desktop. The split is deliberate: connecting to an absent accessibility bus does
not raise, it aborts the interpreter on some `at-spi2` builds, which would take
the entire `--no-live` run down with it (`tests/test_env.py:7-12`).

The `--no-live` lane works by deselecting anything marked `@pytest.mark.live`
(`conftest.py`). `test_env.py:23` carries `@pytest.mark.live` on its
desktop-reachability test precisely so that a bus-less machine skips it rather
than dying. The typelib import half of that module runs in `--no-live` because
it checks that `gi.require_version("Atspi", "2.0")` succeeds — which is the
venv check, not the bus check.

In the sandbox the `--no-live` lane runs green: 464 passed, 45 skipped. The 45
are the live tests.

---

## 6. The venv import check

A plain `python3 -m venv` cannot import `gi` — the system package
`python3-gi` installed the typelibraries into the system path, not into a
copyable location. The failure looks like a missing dependency rather than a
venv flag. The fix is `--system-site-packages` (`README.md`).

This is a documented failure mode, not a workaround: the typelib import test
exists so that a broken venv is caught as "your venv can't see gi" rather than
as a mysterious `ModuleNotFoundError` three layers into a backend.

---

## 7. Diagnosis from stderr

`describeFailure` takes the last three lines of stderr, not one
(`clients/mastra-plugin/src/index.ts:47-73`). A single last line silently truncated wrapped
messages: "exited with code 1" was actually "another service is already
listening on that socket", which the caller could have acted on immediately
(`index.ts:40-45`). `DIAGNOSIS_LINES = 3` — a few lines of frame noise costs
the model nothing; a confidently-cropped diagnosis costs it the answer
(`index.ts:61-65`).

### The stale daemon hint

`METHOD_NOT_FOUND` from a method the client's generated protocol swears is there
is almost always a stale daemon: the shared service serves the code it booted
with, and a method added after it started does not exist to it. The socket is now
keyed on the schema digest (`daemon-<digest>.sock`), so a client whose protocol
differs from the running daemon never attaches to it — it finds its own socket
and starts a matching build. `staleDaemonHint` remains as a diagnostic for the
case where a same-digest daemon has still drifted, comparing the service's
schema digest to the client's and appending a sentence pointing at the restart
(`index.ts:89-92`). The code comment records this cost forty minutes once.

### Paced timeout arithmetic

`typeText` and `editText` type at a measured cadence (70 wpm by default). The
plugin estimates how long the typing will take and sizes its timeout
accordingly, so a paced call does not time out mid-sentence
(`index.ts:114-128`). `PACED_HEADROOM_MS = 30_000` covers the settling after the
typing, a stalled toolkit call, and the round trip — not the typing time itself.

---

## 8. The push lane

Everything else in the plugin is pull — the model asks, the service answers. The
push lane is the one path where a change on the desktop reaches the model
without anybody having called a tool (`desktop-signal-provider.ts:1-7`). That is
the capability the whole project exists for.

### Why it polls a socket instead of being pushed to

The service is genuinely event-driven — AT-SPI events, no polling of the
accessibility tree. But the push lane polls the socket for deltas rather than
receiving them as server push (`desktop-signal-provider.ts:9-24`):

1. Each client asks for what changed *since its own cursor*. A client that was
   disconnected, slow, or restarted resumes exactly where it left off. Server
   push would have to solve that separately, and would solve it worse.
2. Delivery becomes idempotent for free. A change is either past a thread's
   cursor or it is not; no ledger of "have I mentioned this yet" is required.
3. The cost being avoided is a local Unix-socket round trip against an answer
   the service has already computed. No model, no tree walk. Polling *the
   desktop* would be indefensible; polling a precomputed integer is not.

The model still gets a push. That is the part that matters.

### Priority is not a free parameter

Proven against the runtime in `idle-behavior.gate.test.ts`, not assumed
(`desktop-signal-provider.ts:28-33`): `medium` and `high` honour
`ifIdle: { behavior: 'persist' }` and touch no model, while `low` is deferred
into a digest whose sender overrides the idle behaviour and wakes the thread.
The quietest-looking priority is the one that starts a headless run. Desktop
deltas therefore go out at `medium` for ambient changes and `high` for
interrupt-class, and never at `low`.

`INTERRUPT_KINDS = { "window-closed" }` — the one structural change a worker
cannot discover later without consequence (`desktop-signal-provider.ts:75-81`).
Everything else in the vocabulary is news, and news travels at ambient priority.

### The summary is a summary, not a payload

`summarize()` deliberately caps at `MAX_SUMMARY_LINES = 6` and says "and N more"
rather than dumping every change (`desktop-signal-provider.ts:102-123`). The
model sees a notification summary until it reads the record, and a wall of
change objects would be noise it cannot act on. If the delta is incomplete
(earlier changes were dropped), the summary says "re-read from revision X" — no
model, no tree walk.

### The arming processor

An `InputProcessor` that contributes nothing to the model's input — it returns
the message list untouched (`processor.ts:1-8`). Its whole job is to run on
every turn and say "this thread exists" to the push lane, because the turn that
matters most for this feature is precisely the turn where the model called no
desktop tool at all.

Thread identity comes from the memory request context, not from arguments,
because `processInput` is handed the context but not the ids (`processor.ts:9-13`).
A turn without memory-backed thread ids simply does not arm.

`arm` is deliberately awaited rather than fired-and-forgotten: a floating
promise inside somebody's turn is how unhandled rejections get invented later
(`processor.ts:46-49`).

### One provider instance

`buildPushLane(service)` creates one `DesktopSignalProvider` per plugin load,
shared by the signal-provider lane and the arming processor
(`signals/index.ts:1-22`). Two of them would mean one subscribed provider and
one polling provider that never learned a thread existed.

### The lane never starts the service

Every tool in the plugin starts the service on demand — the model asked for
something, so the thing that answers should exist. The push lane must not work
that way (`signals/source.ts:4-17`). It runs on every turn of every session,
including the ones that will never touch the desktop, and a plugin that spawns a
daemon merely because it loaded is bad company to keep.

So the lane attaches to a service that is already running and is silent
otherwise. Attaching to a shared daemon that was listening before this client
existed is what lets a delta reach the model on a turn where nothing was asked
of the desktop at all.

---

## 9. Numbers

| What | Value | Source |
|------|-------|--------|
| Schema methods | 28 | `protocol/schema.json` |
| Error codes | 14 | `protocol/schema.json` |
| Schema digest | `bfa45250563894d0` | `protocol_generated.py`, `protocol.generated.ts` |
| Default poll interval | 1000 ms | `desktop-signal-provider.ts:136` |
| Max summary lines | 6 | `desktop-signal-provider.ts:123` |
| Diagnosis lines | 3 | `clients/mastra-plugin/src/index.ts:65` |
| Paced headroom | 30 s | `clients/mastra-plugin/src/index.ts:126` |
| Max probe depth | 12 | `probe.py` |
| Max probe nodes | 600 | `probe.py` |
| Default call timeout | 15 s | `backends/loop.py:33` |
| Plugin tests | 65 (9 files) | `pnpm -C clients/mastra-plugin test` |
| `--no-live` lane | 464 passed, 45 skipped | `pytest --no-live` |

---

## Sources

| Claim | Source |
|-------|--------|
| One-thread rule | `backends/loop.py:1-12` |
| Default context lesson | `backends/loop.py:62-67` |
| Shutdown releases blocked callers | `backends/loop.py:44-48, 107-130` |
| Bus probe, not gsettings | `backends/atspi.py:118-172, 193-197` |
| Depth ceiling reproducibility | `docs/07-open-questions.md:52-54` |
| Frame vs widget actions | `docs/07-open-questions.md:111-116` |
| Zoom retraction | `docs/07-open-questions.md:108-126` |
| `--no-live` lane design | `tests/test_env.py:7-12` |
| `describeFailure` / `diagnosisFrom` | `clients/mastra-plugin/src/index.ts:40-73` |
| Stale daemon hint | `clients/mastra-plugin/src/index.ts:89-92`; `docs/07-open-questions.md:155-169` |
| Paced timeout | `clients/mastra-plugin/src/index.ts:114-128` |
| Push lane polls socket | `clients/mastra-plugin/src/signals/desktop-signal-provider.ts:9-24` |
| Priority is proven, not assumed | `desktop-signal-provider.ts:28-33` |
| Interrupt kinds | `desktop-signal-provider.ts:75-81` |
| Summary is a summary | `desktop-signal-provider.ts:102-123` |
| Arming processor | `clients/mastra-plugin/src/signals/processor.ts:1-53` |
| One provider instance | `clients/mastra-plugin/src/signals/index.ts:1-22` |
| Lane never starts service | `clients/mastra-plugin/src/signals/source.ts:4-17` |
