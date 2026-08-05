# Security model: who may do what, and how it is said

This document describes the security model of `computer-controls` as it is
implemented in the shipped code. Every claim cites a file and line, a test name,
or a protocol rule. A claim that cannot be so cited is deleted rather than
softened.

The model's shape is stated in the first paragraph of `security.py`:

> The shape of the rule is a ceiling and a hand. The ceiling comes from the
> user's own configuration, read when the service starts, and nothing reachable
> over the socket can raise it. Inside that ceiling a client holds a grant: what
> it may currently do, over which applications, until when. `grantScope` moves
> the hand, never the ceiling. (`security.py:8-14`)

---

## 1. Operation classes

Every method in the protocol declares an operation class — `observe`, `edit`,
`activate`, `submit`, or `destructive` — and has done so since the schema was
frozen (`security.py:3-6`). The class is a fact about the method, written down
once in the generated protocol next to the method, not derived at runtime from
behavior (`security.py:40-45`).

The classes, from `protocol_generated.OPERATION_CLASS`:

| Class | Methods |
|-------|---------|
| `observe` | the 21 read-only methods — `listApplications`, `listWindows`, `queryElements`, `getElement`, `inspectElement`, `getDesktopState`, `getDeltaSince`, `getRevision`, `getDesktopCapabilities`, `captureWindow`, `setAttention`, `setObservationMode`, `hello`, `auditTail`, `grantScope`, `emergencyStop`, `releaseElement`, `focusWindow`(1), `waitFor` |
| `edit` | `editText`, `setElementValue`, `typeText`, `claimElement` |
| `activate` | `focusWindow`, `launchApplication` |
| `submit` | `invokeElement`, `performActions` |
| `destructive` | (declared in the vocabulary; no method carries it in 1.0) |

(1) `focusWindow` appears as both `observe` and `activate` in the protocol —
moving focus is a read-adjacent action that does not change content, but the
schema classifies it. See `docs/03-tool-api.md` for the authoritative per-method
mapping.

The class list is taken from the generated protocol rather than retyped in
`security.py`. A hand-maintained list grew a `focus` class the schema has never
had, which would have produced a grant that parsed, stored, and enforced a
permission no method could ever require — refusing nothing, while looking like
it refused something (`security.py:40-44`).

---

## 2. The ceiling

The `Ceiling` is the most any client may ever be granted, read once at startup
from a file the user owns (`security.py:65-90`). Nothing over the socket writes
to it — that is the entire point of it being a separate object from the grant
(`security.py:67-72`).

The ceiling carries (`security.py:74-90`):

- `classes` — which operation classes are permitted at all. Defaults to
  `{observe}` only (`security.py:49`).
- `applications` — an allow-list. Empty means every application except those
  blocked; non-empty means these and no others, which is the shape a careful
  user wants (`security.py:75-77`).
- `blocked_applications` — a deny-list, checked before the allow-list
  (`security.py:78, 145-146`).
- `application_classes` — how far a client may go *inside* one application,
  where the answer is not the same everywhere (`security.py:164-176`).
- `idle_expiry_seconds` — how long a grant lasts without use. Defaults to 30
  minutes (`security.py:58`). A grant that never expires is a grant nobody
  remembers giving (`security.py:56-57`).
- `confirm_classes` — which classes require per-call confirmation. Defaults to
  `{submit, destructive}` (`security.py:54`).
- `config_key`, `config_path`, `config_exists` — named in every refusal, so a
  denial is actionable rather than a shrug (`security.py:83-90`).

### Applications are matched by identity, never by window title

A title is text the user typed; a boundary drawn on it can be moved by typing
(`security.py:22-23`). Matching is on the application's name, casefolded and
substring-matched (`security.py:138-149`).

### View-only, or interact

The allow-list answers whether an application is reachable at all. It cannot
answer how far a client may go once it is in one, and that is the setting
people reach for first: read my chat app, do not type in it. `applicationClasses`
answers it (`security.py:164-176`):

```json
{"scopes": {"operationClasses": ["observe", "edit", "activate"],
            "applicationClasses": {"discord": ["observe"]}}}
```

An entry replaces `classes` for calls against that application, the same
narrow-answer-wins rule a grant's `per_application` follows, and it is capped by
`classes` — a per-application line is a narrowing device, never a side door
(`security.py:286-311`). Two rules differ from the grant's version on purpose:

- **Naming one application says nothing about the others.** A grant that names
  applications individually has described its whole extent, so the ones it did
  not name are outside it. This map sits behind an allow-list that already
  decides who is in and who is out, so an application with no entry is governed
  by `classes`. Reading an absent entry as a refusal would turn every file that
  pins one application to view-only into a file that shut down every other
  application on the desktop.
- **The highest class named carries the ones below it.** `OPERATION_CLASSES` is
  a severity ladder, so `activate` admits the `observe` and `edit` reads an
  interaction is made of (`security.py:82-101`). A user who ticks interact has
  already said view. The implication is applied where the answer is read and
  never written back, so the file keeps the word the user chose.

The cap is enforced in `decide`, separately from the grant's own answer so the
refusal can say which of the two refused (`security.py:957-969`). A client told
only that it "holds observe" when the *file* is what pinned the application to
view-only would go and ask for a wider grant, be given one, and be refused in
exactly the same place again. A `per_application` entry asking for more than the
file allows there is refused at `grantScope` for the same reason
(`security.py:719-742`): a grant that appears to have been issued and then
refuses everything it covers is a grant somebody debugs for an hour. The general
classes are not held to that check — they apply everywhere, and the file
narrowing one application is the narrowing working.

Every check reads the ceiling live, so a checkbox ticked now bites a grant
already issued, without a reconnect and without a restart.

### The refusal tells you what to do

A denial names the configuration key and the file path it came from. A first
run has no configuration file, and the refusal says so: "Create
`~/.config/...json` containing `{"scopes": {"operationClasses": [...]}}` and
restart the service. Nothing reachable over this socket can do it for you."
(`security.py:101-118`). A key on its own sends the reader looking for a file;
the path is the difference between "ask your administrator" and "edit this"
(`security.py:82-84`).

---

## 3. Grants

A `Grant` is what one client currently holds. It is mutable because it expires
(`security.py:156-178`).

### What an ungranted session may do

An ungranted session observes and nothing else (`security.py:16-20`). Not
because observing is harmless — it is not, which is what the redaction module
is for — but because a client that has just connected has demonstrated nothing
except that it can connect.

### Per-application scoping

A grant can say different things about different applications
(`security.py:162-170`). A task that reads notes from an editor and sends them
from a browser needs to `submit` in one of those and never in the other; a
single class set applied to a list of names cannot say that, and would quietly
hand the editor a permission the task never asked for. An entry in
`per_application` **replaces** `classes` for calls against that application
rather than adding to it, so the narrow answer wins where there is one
(`security.py:168-170`).

`hand_in(application)` answers what this client holds against a specific
application. Once a grant names applications individually, the ones it did not
name are outside it — `hand_in` returns `None`, which is a refusal, not an
absence of opinion (`security.py:183-205`).

### Grant moves the hand, never the ceiling

`grantScope` narrows a client's hand within the ceiling; it never widens the
ceiling (`security.py:276`). Every class named anywhere in a grant — including
the ones only named against a single application — faces the ceiling
(`security.py:296-316`). A per-application entry is a narrowing device, never a
side door around the ceiling. A request for more than the configuration allows
is refused by name, so the answer to "why can't I" is a config key rather than
a shrug (`security.py:12-14`).

---

## 4. Confirmation

Some classes require the caller to have meant it, per call. The `confirm` field
has been in the request envelope since the schema froze, precisely so that
per-call confirmation could be turned on without touching the protocol
(`security.py:51-54`).

By default, `submit` and `destructive` require `confirm: true`
(`security.py:54`). A method that requires confirmation and does not receive it
fails with `PERMISSION_DENIED` — a *runtime* refusal, not a schema change
(`protocol/README.md:30-34`).

The rule (`security.py:429-434`): a caller with a `submit` grant can invoke
actions, but each one must say `confirm: true`. The flag is how a caller says
it meant *this one*, rather than having meant the whole class once.

---

## 5. Idle expiry

A grant expires after `idle_expiry_seconds` of **inactivity**, not after an
absolute lifetime. A grant that expired mid-task while being used every second
would be an absolute deadline wearing the word "idle", and the client would
discover the difference halfway through a sentence (`security.py:173-177`).

When a grant expires and the next call is not observation, the service raises
`SESSION_EXPIRED` with a remedy: "Call `grantScope`. Nothing was revoked in
anger — it simply timed out." (`security.py:403-412`).

`PERMISSION_DENIED` and `SESSION_EXPIRED` are separate on purpose
(`protocol/README.md:155-157`): "you may not do this" and "you may, but ask
again" call for different client behavior.

---

## 6. Redaction

### Where it is enforced

Every name and value that leaves a backend passes through a single egress point
(`protocol/README.md:159-164`). The redaction policy is installed on that point,
not scattered across the codebase. Every element name, every element value,
every window title, and every change summary already passes through one function
(`redaction.py:1-8`).

### How it decides — by role and application, never by content

Two rules decide, and neither reads the text (`redaction.py:10-23`):

1. **The element's own role.** A password entry is a password entry whether it
   currently holds a passphrase, a typo, or nothing at all, and the toolkit
   says so. `SECRET_ROLES` covers `password text`, `password_text`,
   `passwordtext` (`redaction.py:46`). `SECRET_STATES` covers `is-password` and
   `password` — GTK4 reuses the ordinary entry role and marks the widget
   instead (`redaction.py:50`).

2. **The application it belongs to.** A password manager's entire window is a
   list of secrets wearing ordinary roles, and a policy that only knew about
   password fields would hand over every one of them as a perfectly innocent
   label (`redaction.py:14-17`).

What is deliberately absent is any inspection of the text itself. A rule that
redacted anything shaped like a key would redact a chat message about a key,
miss a passphrase that reads like a sentence, and leave the caller unable to
predict either (`redaction.py:19-23`).

### What a redacted value looks like

A redacted value is **replaced, never omitted**. The element still appears,
still has an id, and can still be typed into — an agent filling in a login needs
to know the field is there (`redaction.py:25-29`). It reads back as a marker
rather than as text: `MARKER = "[redacted]"` (`redaction.py:41`). The marker is
not empty and not a run of asterisks, because an agent that read `••••••••`
back could reasonably decide that eight characters is the password, and try to
use it (`redaction.py:38-41`).

### Sensitive applications by default

`DEFAULT_SENSITIVE_APPLICATIONS` includes `bitwarden`, `1password`, `keepassxc`,
`keepass`, `lastpass`, `dashlane`, `enpass`, `seahorse`, `gnome-keyring`,
`keyring`, `polkit`, `gcr-prompter`, `ssh-askpass`, `pinentry`, `authenticator`
(`redaction.py:122-140`). These are listed in source rather than left to
configuration because "a default that has to be discovered is a default that
leaks first and gets configured afterwards" (`redaction.py:117-121`).

Configuration **extends** the built-in list rather than replacing it. A config
file that named its own applications and thereby switched off the defaults would
be a footgun aimed at exactly the thing this module exists to protect
(`redaction.py:143-152`).

### The label is not the secret

For a secret-role element, the field's *label* ("Password", "Confirm password",
"Master key") is how an agent tells which field is which. Withholding labels
turns a login form into three anonymous boxes the agent has to guess between.
What is withheld is the *contents*, not the label (`redaction.py:86-93`).

---

## 7. Capture blocklist

Pixels have no egress door: an image of a password manager is an image of the
passwords, and no filter that understands strings can help. So capture is gated
on the *application* instead — a blocked application yields no image at all,
rather than a blurred one (`policy.py:1-7`).

The blocklist is read from `DESKTOP_CAPTURE_BLOCKED_APPLICATIONS`, matched on
the application name (`policy.py:20-27, 48-49`). Nothing a caller sends can
widen it, because a permission an agent can grant itself is not a permission
(`policy.py:9-10`).

---

## 8. Element ownership during writes

A write to an element is not one event. Typing is a word at a time; an edit is
a search, a deletion, and an insertion, each its own short trip onto the
toolkit thread. The loop serializes those trips individually and nothing above
it serializes the sequence, so two writers aimed at the same field produce text
neither of them asked for — and both are told it worked, because each one's
inserts really were accepted. Interleaved text is worse than a refusal precisely
because it looks like a success (`holds.py:1-9`).

So an element is **owned** for the length of a write. The second writer is
refused and told who holds it (`holds.py:11-15`). Two rules follow
(`holds.py:17-25`):

1. **Ownership is per element, never per application.** Two agents working in
   one window is the case this service exists to support; two agents in one text
   field is the case it exists to prevent.
2. **The rule lives in the service, not in a client.** A guarantee a caller can
   decline to use is not a guarantee, and there is nothing to stop a script, a
   test, or a second connection from calling the service directly.

### Holds versus claims

Two shapes, one type (`holds.py:74-97`):

- A **hold** taken by a write lasts exactly as long as that write and has no
  lease — it cannot outlive the call that took it.
- A **claim** taken by `claimElement` spans however many calls the caller needs
  and is bounded by a lease sized from the work it was taken for.

A lease may not end in the middle of a write it is covering: an agent that
claimed a field and then typed into it would otherwise be *less* protected than
one that never claimed at all, because a plain write's hold cannot expire and a
claim's can (`holds.py:148-154`).

### Lease parameters

- `CLAIM_MARGIN_MS = 2_000` — added to the caller's estimate so work that
  finishes just after the typing does is not interrupted (`holds.py:53-57`).
- `DEFAULT_LEASE_MS = 30_000` — what a claim gets when the caller says nothing
  about the work (`holds.py:59-62`).
- `MAX_LEASE_MS = 600_000` — the ceiling. "A lease nobody can outlive is
  ownership wearing a lease's name." (`holds.py:64-66`).

The write methods are derived from the operation class the protocol already
assigns them, not listed separately — "a list would be a second place to
remember, and the method that got forgotten in it would be the one that quietly
went unowned" (`holds.py:43-51`).

---

## 9. Emergency stop

`emergencyStop` revokes every grant and refuses to issue any new one until
explicitly cleared (`security.py:342-366`).

It needs no grant to pull, which is deliberate: a stop you need permission to
pull is not a stop (`security.py:349-350`). It also revokes grants belonging to
clients that did not pull it. Today's behavior — a stop on one connection
revokes the others — is asserted by
`tests/test_connections.py::test_a_stop_pulled_on_one_connection_revokes_the_others_grant`
so that changing it has to be a decision (`security.py:357-360`).

While stopped, the service refuses everything except observation
(`security.py:391-395`). `grantScope` during a stop raises `PERMISSION_DENIED`
with the remedy: "Clear the stop deliberately; it does not time out on its own."
(`security.py:283-290`).

---

## 10. The audit log

One line per call, including the calls that were refused (`audit.py:1-6`).

A log of what an agent did is half a log. The refusals are the half worth
keeping: an agent that tried to close a window and was told no is a fact about
the agent, and it is invisible in a record that only lists what succeeded
(`audit.py:3-6`).

### Format and permissions

Records are JSON, one per line — the format has to survive being read by
something that is not this program: `tail -f` during a demo, `jq` after an
incident, a client that wants to show the user what happened this morning
(`audit.py:13-15`). The file is opened `O_WRONLY | O_CREAT | O_APPEND` with
mode `0600` — "the log names which applications an agent touched and when
somebody was at the machine. That is not for other users on this box."
(`audit.py:136-138`).

`RECORD_VERSION = 1` (`audit.py:35`) so anything reading these later can tell
what shape it is looking at without guessing from the keys present.

### What is not in a record

No element value, no window title, no typed text (`audit.py:17-21`). The audit
log is a fourth sink for exactly the values the redaction module exists to
withhold, and it is the easiest one to forget, because it feels like somewhere
secrets are safe. It is on somebody's disk. Records carry what was done, to
which application, and how it went — never the contents.

There is deliberately no free-form bag in the record (`audit.py:98-101`): a
record with somewhere to put "anything else relevant" is a record that
eventually has the contents of a field in it, added by somebody who was
debugging and meant to take it out again.

### Write failure is counted, not raised

A logging call that raises would turn a working desktop action into an error,
which is the wrong trade: the action really happened. A logging call that
swallows everything turns a full disk into a service that quietly stops
recording, which is worse. So a write failure is counted and reported through
`health`, and the caller's action proceeds (`audit.py:110-117, 152-157`).

---

## 11. What this model does NOT guarantee

These are not gaps to fill; they are limits stated in the source.

**Emergency stop cannot undo an action already dispatched.** There is no
un-click, and a stop that implied otherwise would be worse than no stop, because
someone would rely on it (`security.py:25-27, 344-347`).

**The model decides permission, not judgement.** It cannot decide whether an
action is a good idea; it decides whether it is permitted. The judgement stays
with the model and the human, where it belongs (`security.py:27-29`).

**Emergency stop revokes across connections, which is a single-user assumption.**
The only thing that could reach this socket was on the same single-user machine,
so the worst case was a person interrupting themselves. A client holding a
server URL and a credential is not on that machine. That makes the cross-
connection revocation a blocker on any network-facing layer rather than the
documented trade-off it was recorded as (`security.py:350-360`).

**Observation of a blocked application is refused, not redacted-after-the-fact.**
A window the user has walled off is not visible, rather than visible-but-
unactionable. Reading a password manager's window is the thing being prevented,
not clicking in it (`security.py:383-399`).

**Attention can only subtract from what the ceiling allows.** The consent
ceiling filters first and produces a set; attention narrows that set further.
There is no ordering in which asking reveals whether a walled-off application
is even running (`protocol/README.md:138-140`).
