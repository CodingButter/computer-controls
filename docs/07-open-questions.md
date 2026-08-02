# Open questions

Gaps this build does not close, recorded so that the next person does not spend
an afternoon rediscovering them. Each entry names the application, what is
actually observed, how to reproduce it, the best current explanation, and which
tier picks up the work instead.

An entry leaves this file when someone closes it with a test, not when someone
feels better about it.

---

## Electron applications expose a frame and almost nothing under it

**Applications** — vesktop (Discord), and Electron generally. Measured in
`05-compatibility-matrix.md`.

**Symptom** — the application appears on the accessibility bus, answers as a
`frame`, advertises the `Collection` interface, and then yields about thirty
nodes for an entire chat client. Its two frame actions are the Chromium
defaults, `doDefault` and `showContextMenu`, so nothing in the window is
addressable by meaning. Depth is not the limit: the walk reaches its ceiling on
a tree that is genuinely that small.

**Reproduce** — `service/tests/probe_lazy_tree.py`, run from `service/` with
`PYTHONPATH=.`. It counts a window's nodes, waits three seconds with an
assistive client attached, and counts again.

**Hypothesis, tested and rejected** — that Chromium builds its accessibility
tree lazily once an assistive client announces itself, so the first read is
early rather than wrong. It does not: vesktop reads 8 nodes at t0 and 8 nodes
three seconds later, Chrome reads 98 and 98. Whatever the tree is going to be,
it already is by the time we look.

**Hypothesis, current** — this is the embedder's choice, not the engine's.
Google Chrome and vesktop run the same Chromium and give completely different
answers: Chrome exposes 277 nodes across its windows with a working `Collection`
interface, vesktop exposes 30. Chromium's accessibility is opt-in per embedding
application, and an Electron app that never turns it on presents the empty shell
of one that did. Visual Studio Code is the sharper version of the same result —
launched normally, and again with `--force-renderer-accessibility`, it never
joins the accessibility bus at all. It is not a shallow tree; there is no
application there to walk.

**Tier that picks it up** — the Chromium DevTools Protocol, per the layered
backend design: for a Chromium-family application the CDP tier addresses the DOM
directly and does not care what the accessibility bridge was willing to publish.
That tier is not in this build. Until it is, an Electron window is honestly
reported as a shallow tree rather than being made to look driveable, which is
why the compatibility matrix counts ten frame actions before it will use the
words "frame actions".

---

## Zoom exposes one interface and no `Collection`

**Application** — zoom, Qt 6.8.8.

**Symptom** — 237 nodes across 8 windows, reachable by manual walk, but the
application advertises a single accessibility interface and no `Collection`, so
every query is a full traversal rather than a filtered match. One frame carries
an empty title.

**Reproduce** — `scripts/generate-compat-matrix.py`, or `probe.py` against the
`zoom` application id.

**Hypothesis** — Qt's bridge implements the accessible-object interface without
the optional filtering interface. The manual-walk fallback already covers the
functional gap; the cost is time, not capability, and it is bounded by the same
walk limits as everything else.

**Tier that picks it up** — none needed. Recorded because a reader comparing
node counts to query latency should know why Zoom is the slow one.

**Not the same finding as "Zoom exposes no actions."** That sentence was said
once, on the strength of a `0` in the *frame actions* column, and it did not
follow: until now the probe asked only windows what they could do and never
asked a single element inside one. Zero frame actions is the ordinary case —
`gnome-shell`, `gnome-terminal-server` and `update-manager` all read zero and are
driveable — because a toolkit puts its actions on the frame, as GTK4 does, or on
its widgets, as Qt does. The probe now counts action-bearing elements as well
(`actionableElements`, and the `Actionable elements` column beside the frame
one), so the question becomes a measurement instead of an inference. Run
`tests/probe_element_actions.py zoom` from the service directory with Zoom open,
and re-run the matrix generator: whichever way it comes back, the number is a
number. Until then no claim about Zoom's actions belongs in this file, and the
escalation to raw input that the old sentence implied is not earned — raw input
is out of scope for this build by design, and would need a measured dead end
rather than an unmeasured one.

---

## The accessibility layer cannot see a GTK4 gutter

**Application** — gnome-text-editor, and GTK4 applications that draw their own
widgets.

**Symptom** — toggling `settings.show-line-numbers` succeeds, changes the
screen, and produces no accessibility change at all: the tree has 32 nodes and
none of them is a gutter. An agent driving by meaning alone cannot confirm its
own action worked.

**Reproduce** — invoke `settings.show-line-numbers` on the editor frame and
compare `observedEffects` against a capture of the same window.

**Hypothesis** — not a bug. The gutter is drawn, not composed of accessible
widgets, so there is nothing for the bridge to report. A system that produced a
change here would be inventing one.

**Tier that picks it up** — `captureWindow`, which exists for exactly this. The
pixels answer what the tree cannot, addressed by window id rather than by screen
region. Proven: a model given only `captureWindow` correctly read the gutter,
the colour scheme and the first line of text, all three of which the tree could
not express.

---

## An attaching client cannot tell what code the daemon is running

**Symptom** — the shared daemon serves the code it booted with. A client that
attaches to a daemon started before a method existed gets `METHOD_NOT_FOUND` for
a method its own generated protocol swears is there, and nothing in the
handshake explains why.

**Reproduce** — start the daemon, add a method, start a client without
restarting the daemon.

**Hypothesis** — none required; this is a missing field rather than a mystery.

**Tier that picks it up** — the handshake. `hello` should carry the schema
digest the daemon was built against, so a client can compare it to its own and
say something useful instead of guessing.
