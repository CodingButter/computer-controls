# Desktop service

A JSON-RPC service that exposes the running Linux desktop semantically —
applications, windows, and (from phase 2) elements — over a Unix socket.

Run it directly:

```
.venv/bin/python -m desktop_service --session dev
```

It prints `listening <socket path>` once it is ready, which is the line the
plugin's supervisor waits for before sending its first request.

The virtualenv **must** be created with system site packages, or `gi` is
invisible inside it and the failure looks like a missing dependency:

```
python3 -m venv --system-site-packages .venv
.venv/bin/pip install pytest
```

## The threading contract

This is the load-bearing rule of the whole service. Read it before adding
anything that touches the desktop.

> **One GLib main loop thread owns all toolkit access.**

`Atspi` is not thread-safe, and its event delivery requires a running GLib main
loop. So the service fixes the model once, here, and every later phase obeys it:

- `backends/loop.py` owns a single thread running one `GLib.MainLoop`.
  `Atspi.init()` runs on that thread, because it is the thread every subsequent
  `Atspi` call will be marshalled onto.
- The socket server (`transport.py`) accepts on its own thread and serves each
  connection on a thread of its own. It never touches a binding.
- Every call that reaches the desktop goes through `loop.call_on_loop(fn, ...)`,
  which posts `fn` to the loop as an idle source and blocks the calling thread
  until it has a result. Exceptions cross back to the caller, so a backend
  failure surfaces to the request that caused it instead of killing the loop.
- Everything else that touches the desktop attaches to this same loop as a GLib
  source: event callbacks, debounce and ceiling timers, and the reconciliation
  sweep. No subsystem starts a thread of its own to talk to the desktop.

A thread model discovered late is a rewrite, not an extension — which is why it
is written down before there is an event stream to bolt onto it.

## The `gi` containment rule

Every `import gi` in this service lives under `backends/`. Nothing outside that
package touches a toolkit binding.

The rule is `backends/`-wide rather than `atspi.py`-only on purpose: later phases
legitimately need other bindings there — GdkX11 for window focus fallbacks on
X11, GLib for event subscription. Those belong in `backends/x11.py` and
`backends/events.py`, not scattered through the service.

The practical benefit is that the threading contract above becomes checkable by
inspection. If no module outside `backends/` can reach a binding, no module
outside `backends/` can call one from the wrong thread.

`pyatspi` is **not** used and is not a dependency — it is not installed on the
target machine. The binding is `gi.repository.Atspi`.

## Identity

AT-SPI's own `get_id()` is not unique per window: on the development machine,
Chrome's three frames all report `32`. The identity that *is* unique is the
accessible's D-Bus address — the owning application's bus name plus the object
path. Every id this service hands out is derived from that pair, which is why
references stay stable across calls and across processes without a lookup table.

## Ownership of an element being written

A write is not one event. Typing is a word at a time and an edit is a search, a
deletion and an insertion, each its own trip onto the loop thread. The loop
serializes those trips one by one and nothing else serializes the sequence, so
two writers aimed at one field used to produce text neither asked for — and both
were told it worked, because each one's inserts really were accepted.

So an element is **owned** for the length of a write (`holds.py`). A second
writer is refused with `ELEMENT_HELD`, which names the holder, what it is doing
and how long it has been doing it, so the caller can decide between waiting and
writing somewhere else. It is not a queue: a queued sentence would be applied
minutes later to a field that has since changed.

Three things follow, and each has a test that fails if it stops being true:

- **Per element, never per application.** Two agents in one window is the case
  this service exists to support; two agents in one text field is the case it
  exists to prevent.
- **Taken in `actions.perform`.** That is the only point every write crosses —
  handlers, the steps of a batch, tests, and anything importing the module
  directly. A rule enforced above it is a rule with a way around it, and a
  client-side queue is a guarantee the caller can decline to use.
- **Given back on completion or on the connection ending.** An element owned by
  a process that no longer exists is owned for the rest of the session.

Only the methods the protocol classes as `edit` are owned; the set is derived
from the protocol rather than listed, so an edit method added later arrives
owned. Focusing a window or invoking a button takes no hold — there is no
half-finished state for a second caller to land in the middle of. Reading is
never blocked; watching a sentence appear is the point.

`release()` without a holder filter is the seam preemption needs — the trigger,
when a person takes a field back from an agent, belongs to the user-takeover
work and is not implemented here.

## Tests

```
.venv/bin/python -m pytest -q              # everything this machine can run
.venv/bin/python -m pytest -q --no-live    # only the tests that need no desktop
.venv/bin/python -m pytest -q --live-only  # only the tests that drive a real one
```

The suite is two suites. Most of it is arithmetic — a protocol, a registry, a
delta engine, a consent ceiling — and runs anywhere, including a container with
no display. The rest drives whatever session is actually logged in, and any
module whose name ends in `_live` is marked as such automatically.

A run on a machine with no reachable display deselects the live tests and says
so, rather than failing in a way that reads like a regression. The display is
probed by connecting to it, never by reading `DISPLAY`, because a service
started from an SSH shell inherits no `DISPLAY` and drives a desktop perfectly
well once it has found one.

The live tests assert invariants — an application has an id, a window title is
stable across two listings — and never a fixed count. The count was 21 during
planning and will not stay 21.
