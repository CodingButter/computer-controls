# Research findings: AT-SPI2 as a semantic desktop control

This document records what the build of `computer-controls` learned about the
Assistive Technology Service Provider Interface (AT-SPI2) and the Linux
accessibility stack. It is written for a reader who will never open the source:
every claim cites a probe result, a test name, or a file and line. A claim that
cannot be so cited is deleted rather than softened.

The research plan that these findings answer lives in `Research and Design a.md`
at the repository root — it lists the questions. The answers live in the code:
`service/desktop_service/backends/atspi.py`, `probe.py`, `capabilities.py`, and
`protocol/README.md`. The mission underneath both is *semantic* desktop control
— `listApplications`, `focusWindow`, `queryElements`, `invokeElement`,
`setElementValue` — over the screenshot-and-coordinate loop that vision-only
agents run. When a semantic operation cannot complete reliably, the design falls
back one rung at a time: agent intent → semantic API → app integration → Linux
accessibility → compositor → vision/OCR → raw input. Each lower rung is reached
only when the rung above it cannot finish the job (`capabilities.py:112-178`).

---

## 1. The accessibility bus, and why it aborts the interpreter

AT-SPI2 is a D-Bus service. To reach it, an application asks the session bus for
the well-known address of `org.a11y.Bus`. On a machine that has no accessibility
bus — a headless server, a CI sandbox, a misconfigured desktop — `Atspi`
discovers this the hard way.

`Atspi.get_desktop(0)` on such a machine does **not** raise a Python exception.
It emits `dbind-ERROR: AT-SPI: Couldn't connect to accessibility bus. Is
at-spi-bus-launcher running?` through `g_error`, which calls `abort()`. That is a
`SIGTRAP` / core dump, exit 133 — it takes the entire interpreter down with it,
not just the call (`atspi.py:118-172`). The build shipped a `try: ... except
Exception` around one of these calls for months; it was decorative, because
`abort()` is not an exception.

The guard that actually works is **not** an environment-variable check. Checking
`DISPLAY` or `DBUS_SESSION_BUS_ADDRESS` is wrong on both sides: a present
variable does not prove a reachable bus, and an absent one does not prove an
unreachable one. Instead, `bus_reachable()` asks `org.a11y.Bus` for its address
over plain D-Bus (via `Gio`), which fails politely through a `GLib.Error` rather
than aborting (`atspi.py:118-172`). `BUS_PROBE_TIMEOUT_MS` is 3000 ms — long
enough for a real bus under load, short enough that a cold start does not hang
the agent. A *yes* is cached for the lifetime of the process; a *no* is cached
for only `BUS_RETRY_SECONDS` (5 s), so that a desktop that starts after the agent
does is noticed without a restart (`atspi.py:118-172`).

This matters because it shapes the test lanes. The repository runs two of them:
`--no-live` (everything that can pass without a desktop) and `--live-only` (the
rest). `conftest.py` detects live tests through `item.get_closest_marker("live")`
— a pytest marker, not a filename suffix (`conftest.py:83`). A test that connects
to an absent bus aborts the interpreter, which would take the *entire* `--no-live`
run down with it, so the desktop-reachability half of `test_env.py` is marked
`@pytest.mark.live` (`test_env.py:23`) while the typelib-import half is not —
that half checks the venv, not the bus.

The single most important consequence: there is exactly **one door** to the live
desktop. `_desktop()` is the only place `get_desktop(0)` is opened
(`atspi.py:175-189`). The first guard sat on `probe_desktop` alone and was
insufficient — `typeText`'s window lookup reached the desktop root by another
path and still died. Funneling every access through one guarded entry point
closed that.

---

## 2. Identity is not what the toolkit hands you

`Atspi.Accessible.get_id()` is documented as a unique identifier. It is not.
Chrome's three open frames all report `32`; desktop-icon frames report `11`
(`atspi.py:8-13`). A registry that keyed on `get_id()` would hand one element's
reference to a caller who asked for another.

The unique identity of an accessibility object is the owning application's D-Bus
bus name plus the object's D-Bus path — the address at-spi2 itself uses to route
messages. `computer-controls` hashes that into a 12-hex-character id with a
prefix that names the kind of thing: `el-` for an element, `win-` for a window,
`app-` for an application (`atspi.py:83-105`). The prefix is load-bearing: it
lets a caller and the registry agree on *what* a reference denotes without
parsing the id, and it keeps windows from being confused with the elements
inside them.

---

## 3. Tree traversal, and the applications that pretend

The accessibility tree is a tree: a desktop contains applications, applications
contain windows, windows contain elements. Walking it sounds trivial. It is not,
because toolkits lie about its shape in different ways.

**mutter re-parents client windows to draw decorations on them**, and then
publishes the decorative frame as its own AT-SPI application
(`mutter-x11-frames`). Without filtering, the desktop shows two copies of every
window — the application's real one and mutter's frame wrapper — and the agent
sees "two Discords" (`atspi.py:77-81`, the `FRAME_PROVIDER_APPS` set). The fix is
to drop frame-provider applications entirely from the tree.

**Zoom parks stray labels as direct children of the application object**, not
inside a window. A naive walk that only looks for windows would miss them; a walk
that treats any top-level child as a window would invent fake windows. The
`WINDOW_ROLES` set (`frame`, `dialog`, `window`, `alert`) is the discriminator:
only an accessible whose role is in that set counts as a window
(`atspi.py:68-70`).

The probe (`probe.py`) measures how each application actually exposes its tree,
because the answers differ enough to change strategy. It walks a bounded
breadth-first traversal — `MAX_PROBE_DEPTH = 12`, `MAX_PROBE_NODES = 600`
(`probe.py:7-17`) — large enough to reach a real deep spine, small enough to
finish on a hostile app. The bound distinguishes a *wide-shallow* tree (many
siblings, few levels) from a *deep-spine* one (few siblings, many levels),
which is the difference between "this app puts everything on one screen" and
"this app nests menus inside menus."

---

## 4. Querying by role and name

`queryElements` takes any one of `role`, `name`, or `states` and returns the
matches (`protocol/schema.json`, the `queryElements` method's `anyOf` — at least
one must be present). The matching happens in AT-SPI terms, not by stringifying
the tree and grepping: a role is an AT-SPI role constant, a state is an AT-SPI
state flag.

The subtlety is *redaction interacts with names*. A fingerprint — the thing that
lets the registry recognize an element after it moves — is built from the
element's *emitted* name, not its raw name (`atspi.py:602-623`). The emitted name
is the one the redaction layer has already seen. If fingerprints used raw names, a
reference would go stale the instant redaction was switched on for its field,
because the name the registry remembered and the name it now sees would differ.
Building fingerprints from the post-redaction name keeps references stable across
a redaction-policy change.

---

## 5. Invoking actions without a pointer

An accessibility action — clicking a button, toggling a checkbox — is invoked by
*name*, never by AT-SPI's integer action index (`atspi.py:774-786`). The reason
is sharp: **the index list is reorderable between calls.** A toolkit is free to
hand back `["click", "press"]` on one query and `["press", "click"]` on the next.
An agent that invoked by index and saw the list reorder would fire the wrong
action. Invoking by name turns a reordering into a clean no-op-or-correct-call:
the named action either is where it was or fails to be found, but it is never the
*wrong* action.

---

## 6. Editable text: insertion, replacement, and atomic deletion

Editable text is addressed through the `EditableText` interface, and the choice
of method is not cosmetic — applications hear them differently.

`set_text_contents` **replaces** the entire field (`atspi.py:789-832`). An
edit-aware application — one that tracks edits for undo, spell-check, or
autosave — receives this as "the whole thing changed," and hears nothing about
the individual keystrokes.

`insert_text` goes through the interface that "an application received dictated
speech through" (`atspi.py:789-832`). Edit-aware applications *hear* the
insertion as an insertion, because that is the signal dictation software relies
on. This is why the build has both: replacing is right when the caller knows the
full intended contents; inserting is right when the caller wants the application
to understand that text was added at a point.

`delete_text` splices a range **atomically** — one edit event, not forty
single-character deletions (`atspi.py:789-832`). Forty deletions would fire forty
undo steps and forty change notifications; one splice fires one of each.

Offsets that fall outside the field's actual range are an **honest refusal**,
never a silent clamp (`atspi.py:789-832`). The toolkit would happily clamp an
out-of-range offset to the nearest boundary and report success; a caller who
asked to delete from position 500 in a 12-character field has a wrong belief
about the world, and returning success would preserve it.

---

## 7. Text addressed by content, not offsets — and the password-mask verdict

Text is verified by *content*, not by offset, because offsets are fragile and an
agent rarely knows them anyway. `find_range` locates a substring and returns its
range; on ambiguity — two identical matches — it returns `None` rather than
guessing which one the caller meant (`atspi.py:844-897`).

The hard-won result here is the **three-way text verdict**. A naive
did-the-text-match function returns `True` or `False`. But GTK returns the
password mask — the bullets — to the accessibility layer *itself*. So when a
caller types a password and then asks "did it go in?", the accessibility layer
hands back `••••••`, not the real text. A two-way verdict would say *mismatch*,
tell the caller its password did not go in, and invite it to type the thing
again — into a field that already contains it (`atspi.py:900-926`).

`verdict_for` returns one of three answers (`atspi.py:912-926`):

- **`verified`** — the text matches.
- **`mismatch`** — the text does not match and is not a mask.
- **`unverifiable`** — the field contains only mask characters
  (`_MASK_CHARACTERS = frozenset("•*●·⬤∙")`, `atspi.py:903`) where the caller
  expected something else. The field may or may not contain the password; the
  accessibility layer cannot tell, and neither can the caller, so the honest
  answer is "I cannot verify this," not "it failed."

Critically, only the verdict leaves the layer. The raw text never does
(`atspi.py:844-897`). A password's contents are not echoed back as a mismatch
detail; they are not logged; they are not in the change stream. The verdict is
the whole egress.

The rule that produces this verdict lives in exactly one place
(`atspi.py:912-926`). An earlier copy of the rule existed in a test's stub and
kept returning `True` for a masked field long after the real implementation had
learned to say `unverifiable` — the stub drifted, the real code did not, and the
test passed against the wrong behavior. Consolidating the rule into one function
closed that.

---

## 8. Reference lifetimes: staleness and rediscovery

An accessibility object reference is not a stable pointer. Windows close;
elements move; applications rewrite their own UI. The registry has to recognize
that a held element is *the same element* after it has moved, without re-reading
the whole desktop.

A reference carries a **fingerprint** built from the element's role and its
emitted (post-redaction) name (`atspi.py:602-623`). When the registry touches a
held reference, `fingerprint_of` re-derives the fingerprint; if `gi` raises on
the access — the underlying peer object is gone — the element is stale
(`atspi.py:532-541`).

Stale does not mean gone. `rediscover()` re-finds a moved element by **role and
name, deliberately not by position** (`atspi.py:632-672`). Position is exactly
what changed when the element moved; matching on it would never find the thing.
The rediscovery walk is bounded by `REDISCOVERY_MAX_NODES = 400` — enough to find
an element that scrolled out of view, not enough to walk an entire desktop on
every lookup.

And rediscovery refuses to guess. If two elements match the same role and name
— two identical "Submit" buttons — `rediscover` returns `None`, not "one of
them" (`atspi.py:632-672`). Handing back the wrong twin of an identical pair
would be worse than admitting the reference is lost.

---

## 9. Per-toolkit exposure: why the probe measures each app separately

Different UI toolkits expose their accessibility trees in radically different
shapes, and the shape determines which operations can succeed at all. The probe
measures six questions per application (`probe.py:7-17, 31-55`):

1. Which interfaces the application *advertises*.
2. How deep the tree actually walks.
3. Whether `Collection` filtering works (advertised ≠ functional).
4. The action count on frame/window elements.
5. The action count on inner elements.
6. Whether an editable field is present.

The fourth and fifth questions are kept separate for a reason (`probe.py:130-162`):
**GTK4 puts the whole command set on the frame and leaves the tree empty**, while
**Qt does the reverse** — a sparse frame with the actions buried inside inner
elements. A probe that only counted "actions on this application" would collapse
both into one number and hide the strategy difference. Counting frame actions and
inner-element actions separately surfaces it.

`collection_advertised` and `collection_works` are likewise separate
(`probe.py:31-55`). An application can advertise the `Collection` interface — the
efficient server-side filtering mechanism — and then not honor it. The probe
asks both: does the app *claim* Collection support, and does a Collection query
*actually* filter? A claim without function is recorded as such, not as support.

And the probe never fails. An application that answers nothing — no interfaces,
no tree, no actions — is a valid result (`probe.py:130-162`). "This app exposes
nothing useful" is itself a measurement, not an error, and it is the measurement
that tells the fallback chain to drop to a lower rung for that application.

---

## 10. Capability tiers, and honest "unavailable" answers

`capabilities.py` reports the build's capability tiers, and the rule is that an
unimplemented tier is reported **unavailable-with-reason, never omitted**
(`capabilities.py:86-96, 112-178`). An agent that sees a tier absent has no way
to know whether the tier is impossible, unimplemented, or merely turned off; an
agent that sees "unavailable, because …" knows exactly which.

The tiers, as this build reports them:

- **app-native** — `False`. "Deferred by scope: no browser DevTools, Firefox
  remote protocol or application D-Bus adapter is implemented in this build"
  (`capabilities.py:112-178`).
- **accessibility** — the AT-SPI2 tier this document describes; the build's
  primary semantic surface.
- **compositor** — x11 only. Wayland portals are deferred; the build addresses
  windows, not raw screen regions.
- **vision** — `captureWindow` is available, but OCR is `False`: "deferred by
  scope: no OCR engine is bundled with this build." Crucially, screen capture is
  addressed *by window id*: "captures are addressed by window id, so a caller can
  never ask for the screen and never receive somebody else's window in the frame"
  (`capabilities.py:112-178`). This is a security property expressed as a
  capability boundary.
- **raw-input** — `False`. The build checks `/dev/uinput` existence and
  writability and the presence of `xdotool`/`ydotool`/`wmctrl` on `PATH`, and
  reports all of them, then states: "raw input is out of scope for this build by
  design" (`capabilities.py:112-178`).

The probe never trusts a setting. The GNOME `toolkit-accessibility` gsetting reads
`false` on machines where the bridge works perfectly, so it is never consulted
(`atspi.py:193-197`). A positive measurement — can I actually reach the bus, can
I actually walk the tree — always overrides a configuration claim.

---

## 11. Threading: one thread owns the loop

Every function in `atspi.py` runs on the GLib main loop thread
(`atspi.py:5-6`, module docstring). `Atspi` (and `gi` generally) is **not
thread-safe**: calling into it from two threads corrupts the bindings. The
service funnels every accessibility call through `call_on_loop`, which marshals
the call onto the single loop-owning thread. This is not a performance choice;
it is a correctness constraint imposed by the library, and violating it produces
silent data corruption rather than a loud error.
