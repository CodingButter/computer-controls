# Open questions

Gaps this build does not close, recorded so that the next person does not spend
an afternoon rediscovering them. Each entry names the application, what is
actually observed, how to reproduce it, the best current explanation, and which
tier picks up the work instead.

An entry leaves this file when someone closes it with a test, not when someone
feels better about it.

---

## Electron is not opaque; our depth ceiling is

**Applications** — Discord 1.0.151, Visual Studio Code 1.131.0, Google Chrome,
gnome-text-editor as the control. Measured in `05-compatibility-matrix.md`.

**The measurement.** The same walk, run against the same live applications,
varying only the depth it is allowed to reach:

| depth limit | Discord | code | gnome-text-editor |
| --- | --- | --- | --- |
| 6 | 7 | 12 | 9 |
| 12 *(our ceiling)* | 29 | 30 | 39 |
| 18 | 137 | 141 | 143 |
| 24 | 742 | 312 | 146 |
| unbounded | 952 | 621 | 146 |

Discord's deepest node sits at depth 29, VS Code's at 34. An unbounded walk of
either costs a tenth of a second.

**What that costs us, stated as a fraction.** Elements carrying at least one
action, within our depth ceiling versus in the whole tree:

| Application | actionable within depth 12 | actionable in full | named within 12 | named in full |
| --- | --- | --- | --- | --- |
| Discord | 29 | 952 | 3 | 417 |
| code | 30 | 621 | 8 | 313 |
| Google Chrome | 271 | 662 | 92 | 377 |
| gnome-text-editor | 4 | 30 | 5 | 32 |

An agent inspecting Discord from the window root sees three named things out of
four hundred and seventeen. This is not an Electron finding. GTK loses the same
way, in the same direction, at a smaller magnitude.

**Two retractions, both of them mine.** This section previously said an Electron
frame "advertises a child and declines to hand it over". Then it said the tree
"is built while you walk it", from readings of 1, 34, 62 and 137 nodes across
successive walks. The first was a single bounded walk mistaken for the shape of
the tree. The second was worse: those four numbers came from four ad-hoc scripts
with four different depth limits, and 137 is exactly what depth 18 returns today,
every time. I read my own instrument's setting as the application's behaviour,
and wrote it down as a discovery. A walk repeated at a fixed depth returns the
same count on every round, which is the check neither version ran.

**What is still real from those rounds.** These applications did report a single
node this morning and report a full tree now, and no depth limit explains that:
`probe.py` has run at depth 12 throughout, and it moved from 1 node to 30. The
surviving candidate is that a real assistive client attached in between. Setting
`org.a11y.Status ScreenReaderEnabled` moved nothing on its own — but it started
Orca, which is an actual AT walking the tree, and Chromium's documentation is
explicit that full accessibility support is enabled once assistive technology is
detected, and that once enabled it is not turned back off. That fits every
reading we have, and it is still a hypothesis: it was not the experiment, because
the flag and the client were flipped in the same motion.

**The experiment that would settle it** — a cold Electron process, walked at a
fixed depth before and after Orca is started, with the bus flag left alone
throughout. The obstacle to run it today: a throwaway instance launched with its
own `--user-data-dir` never appeared on the accessibility bus at all, which is
its own unanswered question.

**What this changes for an agent.** Discord exposes its message composer as an
`entry`, its sidebar, its direct-message list and 40-plus named controls — an
Electron window is drivable. Reaching them means drilling with `inspectElement`
from an anchor rather than reading a window and believing the result, which the
`desktop_inspect_element` tool description says to do explicitly. A ceiling that
hides 97% of an application without saying so is worse than a ceiling that
refuses: silence reads as absence. The depth cutoff now sets `truncated` and
marks where to drill from, so the ceiling does say so.

**Tier that picks it up** — none. The Chromium DevTools Protocol tier remains the
answer for a page's DOM semantics; it is not needed to reach anything measured
here.

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

## Deferred capability tiers

The capability report (`getDesktopCapabilities`) declares five tiers. Three are
deferred by scope — available `false` with a reason, never omitted — so a caller
can tell the difference between "this desktop cannot do that" and "this build
does not do that yet" (`capabilities.py:11-14`). These are recorded here as open
questions because each is a known limit with a stated path forward, not a gap
left by accident.

### app-native — application-specific integrations

**Status** — unavailable, deferred by scope (`capabilities.py:113-121`).

**Reason** — no browser DevTools Protocol adapter, Firefox remote protocol
adapter, or application D-Bus adapter is implemented in this build.

**What it would unlock** — per-application semantics deeper than the
accessibility tree offers: a web page's live DOM (not its a11y projection),
an editor's document model, a media player's playlist as a first-class object.

**Why it is deferred** — each application is its own integration, with its own
transport and its own stability characteristics. The accessibility tier already
reaches into every one of these applications; app-native tiers would reach
*deeper* in a few, at the cost of one integration per application rather than
one backend per desktop. The architecture reserves the slot
(`capabilities.py:113-121`) so adding an adapter later is additive, not a new
vocabulary.

### compositor — Wayland portal-based control

**Status** — partially available. X11 window management works; Wayland does not
(`capabilities.py:136-153`).

**Reason on Wayland** — "session display server is 'wayland': X11 window
management is unavailable and the Wayland portal path is deferred by scope"
(`capabilities.py:140-145`). The `waylandPortals` detail is `false` with reason
"deferred by scope: portal-based control is not implemented in this build"
(`capabilities.py:148-151`).

**What it would unlock** — `focusWindow`, `launchApplication`, and window
enumeration on Wayland sessions, which the X11 backend cannot reach.

**Why it is deferred** — Wayland's security model requires the Hyper+Xdg portals
for anything another process does with a window, and the portal API is a
different transport from X11. The backend boundary (`backends/`) exists so a
Wayland backend can be added without touching the protocol, and `ROADMAP.md`'s
platform rule holds: "a test fails if a toolkit import appears above it" — i.e.
backend code stays under `backends/`.

### vision — OCR

**Status** — window capture works (subject to the capture blocklist); screen
capture is out of scope by design; OCR is unavailable (`capabilities.py:154-171`).

**Reason for OCR** — "deferred by scope: no OCR engine is bundled with this
build" (`capabilities.py:167-168`).

**Reason for screen capture** — "out of scope by design: captures are addressed
by window id, so a caller can never ask for the screen and never receive
somebody else's window in the frame" (`capabilities.py:161-166`). This is a
design constraint, not a deferral — it will not be filled in later.

**What OCR would unlock** — reading text from a region the accessibility tree
does not model: a canvas, a rendered gutter (`07-open-questions.md` §3, the
GTK4 gutter), or a proprietary widget that draws without composing accessible
children.

**Why it is deferred** — bundling an OCR engine is a dependency and a model
choice (Tesseract, a cloud API, or a local vision-language model are different
decisions with different trust profiles). The `captureWindow` method already
hands the image to the model, which can read it; a bundled OCR engine would
duplicate that capability for the one case where the model is not in the loop.

### raw-input — synthetic pointer and keyboard input

**Status** — unavailable, out of scope by design (`capabilities.py:172-177`).

**Reason** — `/dev/uinput` existence and writability checks, plus
`xdotool`/`ydotool`/`wmctrl` on PATH, plus "raw input is out of scope for this
build by design" (`capabilities.py:86-96`).

**Why it is out of scope** — this is not a deferral; it is the project's
governing constraint. `ROADMAP.md` states the rule: "a semantic desktop, never
a remote shell." Synthetic input bypasses the consent ceiling, the holds
registry, and the redaction layer — it types into whatever has focus, including
a window the user walled off. The accessibility tier's `typeText` and
`setElementValue` go through the same security model as every other method, and
that is the point. Raw input is the thing this project exists to replace, not to
provide.
