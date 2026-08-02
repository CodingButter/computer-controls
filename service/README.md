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

## Tests

```
.venv/bin/python -m pytest tests/test_transport.py tests/test_capabilities.py -q
.venv/bin/python -m pytest tests/test_discovery_live.py -q
```

`test_discovery_live.py` runs against whatever desktop is actually running, so it
asserts invariants — an application has an id, a window title is stable across
two listings — and never a fixed count. The count was 21 during planning and will
not stay 21.
