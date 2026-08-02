# Open questions

Gaps this build does not close, recorded so that the next person does not spend
an afternoon rediscovering them. Each entry names the application, what is
actually observed, how to reproduce it, the best current explanation, and which
tier picks up the work instead.

An entry leaves this file when someone closes it with a test, not when someone
feels better about it.

---

## Electron applications announce a child and then decline to hand it over

**Applications** — Discord 1.0.151, Visual Studio Code 1.131.0, and Electron
generally. Measured in `05-compatibility-matrix.md`.

**Symptom, stated precisely** — the application appears on the accessibility
bus and answers as a `frame`. The frame reports `child_count = 1`. Asking for
that child returns nothing:

```
Discord: app advertises 1 children, handed over 1
   frame advertises 1 handed over 0
code:    app advertises 1 children, handed over 1
   frame advertises 1 handed over 0
gnome-text-editor: app advertises 1 children, handed over 1
   frame advertises 1 handed over 1
```

This is the whole finding, and it is not the one previously recorded here. The
tree is not small and it is not absent. The window knows it contains exactly one
thing — its web contents — and will not produce it. A GTK application asked the
same question in the same breath hands its child over.

**What that rules out.** "Electron never turns accessibility on" does not
survive it: an application that had turned nothing on would report zero children,
not one. Something published the count. Whatever holds the page's nodes is not
answering on the same bus as the thing that counted them.

**Correction to the previous entry.** It claimed Visual Studio Code "never joins
the accessibility bus at all — there is no application there to walk." That is
wrong. VS Code is on the bus, as an application with a frame, behaving
identically to Discord. Withholding a child is not the same as being absent, and
the difference is the entire question.

**Hypothesis, tested and rejected (1) — lazy construction.** That Chromium
builds its tree once an assistive client announces itself, so the first read is
early rather than wrong. Waiting three seconds and walking again grows the tree
by zero nodes, on both Electron and Chrome
(`service/tests/probe_lazy_tree.py`).

**Hypothesis, tested and rejected (2) — the session accessibility flag.**
That Chromium waits for the signal a screen reader sets, and our session has it
off. Setting `org.a11y.Status` `ScreenReaderEnabled` to true — the exact signal,
verified to flip both `IsEnabled` and `ScreenReaderEnabled`, and to start Orca —
and re-walking after thirty seconds moves nothing:

| Application | flag off | flag on, +30s |
| --- | --- | --- |
| Google Chrome | 281 nodes | 281 nodes |
| vesktop 1.6.5 | 30 nodes | 30 nodes |
| code 1.131.0 | 1 node | 1 node |

Chrome is fully exposed with the flag *off*, which is the load-bearing half:
whatever Chrome is doing, it is not doing it because an assistive technology
announced itself.

**Hypothesis, tested and rejected (3) — a launch flag the user can set.**
`--force-renderer-accessibility` is a declared command-line option in VS Code's
main bundle, and on Linux it is additionally re-read from user settings. Running
a throwaway instance with it produces the same two nodes and the same withheld
child. In Discord's and vesktop's bundles the string does not appear at all,
alongside no `setAccessibilitySupportEnabled` call — for those two there is no
switch to fail to find.

**What Chrome does instead** — the same walk on Chrome reaches a `document web`
node that hands over its child, and 398 nodes of page content below it. Chrome's
frames are not special; its renderer answers. Two of its three frames yield 5 and
7 nodes, because they have no page in them.

**Not settled** — why the count is published when the subtree is not. The
candidate worth measuring next is Electron version and bundled Chromium version:
vesktop 1.6.5 yielded 30 nodes where official Discord 1.0.151 yields 1, which is
a 30× difference between two builds of the same product, and is the only variable
so far that has moved this number at all.

**Tier that picks it up** — the Chromium DevTools Protocol, per the layered
backend design: for a Chromium-family application the CDP tier addresses the DOM
directly and does not care what the accessibility bridge was willing to publish.
That tier is not in this build. Until it is, an Electron window is honestly
reported as a shallow tree rather than being made to look driveable.

**Tier that picks it up** — the Chromium DevTools Protocol, per the layered
backend design: for a Chromium-family application the CDP tier addresses the DOM
directly and does not care what the accessibility bridge was willing to publish.
That tier is not in this build. Until it is, an Electron window is honestly
reported as a shallow tree rather than being made to look driveable, which is
why the compatibility matrix counts ten frame actions before it will use the
words "frame actions".

---

## Zoom exposes one interface and no `Collection` (and 218 actionable elements)

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
one), so the question becomes a measurement instead of an inference.

**Measured, 2026-08-02, Zoom running on this desktop** — 237 nodes, 0 frame
actions, **218 actionable elements**: push buttons offering `Press`, lists and
labels offering `SetFocus`, scroll bars offering `Increase` and `Decrease`. Zoom
is driveable, and the earlier sentence was wrong about it. The escalation to raw
input that sentence implied is not earned and is not needed — raw input remains
out of scope for this build by design, and would need a measured dead end rather
than an unmeasured one. Reproduce with
`PYTHONPATH=. .venv/bin/python tests/probe_element_actions.py zoom` from the
service directory.

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
