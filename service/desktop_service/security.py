"""Who may do what, decided here rather than by the thing asking.

Every method in this protocol declares an operation class — observe, focus,
edit, activate, submit, destructive — and has done since the schema was frozen,
which is why this file adds no field to a frozen protocol. The class is a fact
about the method, written down once, next to the method.

The shape of the rule is a ceiling and a hand. The ceiling comes from the
user's own configuration, read when the service starts, and nothing reachable
over the socket can raise it. Inside that ceiling a client holds a grant: what
it may currently do, over which applications, until when. `grantScope` moves
the hand, never the ceiling — a request for more than the configuration allows
is refused by name, so the answer to "why can't I" is a config key rather than
a shrug.

An ungranted session observes and nothing else. Not because observing is
harmless — it is not, which is what the redaction module is for — but because a
client that has just connected has demonstrated nothing except that it can
connect, and the difference between reading a window and closing it is the
difference this whole file exists to keep.

Applications are matched by identity, never by window title. A title is text
the user typed; a boundary drawn on it can be moved by typing.

Two things this module deliberately cannot do. It cannot undo an action already
dispatched to a toolkit — there is no un-click, and emergency stop is a
statement about the future. And it cannot decide whether an action is a good
idea; it decides whether it is permitted. The judgement stays with the model
and the human, where it belongs.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Final

from . import attestation, protocol_generated
from .errors import DesktopError, ErrorCode, PermissionDenied, SessionExpired

log = logging.getLogger(__name__)

#: Taken from the generated protocol rather than typed here. Written by hand
#: this list grew a `focus` class the schema has never had, which would have
#: produced a grant that parsed, stored and enforced a permission no method
#: could ever require — refusing nothing, while looking like it refused
#: something.
OPERATION_CLASSES: tuple[str, ...] = protocol_generated.OPERATION_CLASSES

#: What a session may do before anyone has granted it anything. Read-only, and
#: read-only means observe only.
DEFAULT_CLASSES: frozenset[str] = frozenset({"observe"})

#: The classes that require the caller to have meant it, per call. `confirm`
#: has been in the request envelope since the schema froze precisely so that
#: this could be turned on without touching the protocol.
CONFIRM_BY_DEFAULT: frozenset[str] = frozenset({"submit", "destructive"})

#: How long a grant lasts without use. A grant that never expires is a grant
#: nobody remembers giving.
DEFAULT_IDLE_EXPIRY_SECONDS = 30 * 60


def severity_of(classes) -> dict:
    """How much damage a mistake with these classes can cause.

    rank is the ordinal of the highest held class in OPERATION_CLASSES
    (observe=0 … destructive=4) — the severity ladder the class list already
    encodes. irreversible is True when any held class is in
    CONFIRM_BY_DEFAULT, the ones a confirm dialog was born for. Both are
    facts about the classes held, not opinions about which model should hold
    them.
    """
    held = [c for c in OPERATION_CLASSES if c in classes]
    rank = OPERATION_CLASSES.index(held[-1]) if held else 0
    irreversible = bool(set(classes) & CONFIRM_BY_DEFAULT)
    return {"rank": rank, "irreversible": irreversible}


def implied_classes(classes) -> frozenset[str]:
    """These classes and everything the highest of them already contains.

    OPERATION_CLASSES is a severity ladder rather than a bag of independent
    flags — the same ladder `severity_of` reads a rank off. Permission to
    activate a control that did not carry permission to read it would describe
    a client clicking blind, which is not a thing anybody means to grant; a
    user who ticks "interact" has already said "view" and should not have to
    say it twice.

    Applied where the answer is read, never where it is written. The file keeps
    the word the user chose, so a configuration that says `activate` still says
    `activate` after a round trip through a permissions page, and the day the
    ladder gains a rung the old files mean the new thing without being
    rewritten.
    """
    held = [c for c in OPERATION_CLASSES if c in classes]
    if not held:
        return frozenset()
    return frozenset(OPERATION_CLASSES[: OPERATION_CLASSES.index(held[-1]) + 1])


def breadth_of(grant: "Grant", ceiling: "Ceiling") -> dict:
    """How wide a net this grant casts.

    applications is the count of distinct application identities the grant
    could act against. anchors is the count of element-anchored permissions
    hung on the grant (A15) — each one is a separate place to keep track of,
    so it counts toward the same spread the applications do.

    A grant that names no applications inherits the ceiling's list, and a
    ceiling that names none means every application there is. Reporting that
    as zero would read as the narrowest possible scope when it is the widest
    one available, so it is counted and flagged rather than summed: the count
    is what is nameable, `unbounded` is the warning that the real number is
    however many applications happen to be running.
    """
    anchors = len(grant.anchors)
    apps = set(grant.applications) | set(grant.per_application.keys())
    if apps:
        return {"applications": len(apps), "anchors": anchors, "unbounded": False}
    return {
        "applications": len(ceiling.applications),
        "anchors": anchors,
        # In per-application mode an empty list is the narrowest scope there
        # is — nothing — not the widest. Only open mode's empty list means
        # "however many applications happen to be running".
        "unbounded": not ceiling.applications and ceiling.permissions_mode == OPEN_MODE,
    }


class ScopeError(PermissionDenied):
    """Raised when a caller asks for more than the configuration allows."""


#: The two readings of an empty application list. Open is the historical one:
#: nothing named means nothing withheld. Per-application is the checkbox
#: reading: nothing named means nothing permitted, and a newly installed
#: application arrives unpermitted rather than pre-approved. The mode is part
#: of the user's file for the same reason the list is — a default a client
#: could flip is not a default.
OPEN_MODE: Final = "open"
PER_APPLICATION_MODE: Final = "per-application"
PERMISSIONS_MODES: Final = (OPEN_MODE, PER_APPLICATION_MODE)


@dataclass(frozen=True)
class Ceiling:
    """The most any client may ever be granted, from the user's configuration.

    Read once at startup from a file the user owns. Nothing over the socket
    writes to this — that is the entire point of it being a separate object
    from the grant.
    """

    classes: frozenset[str] = DEFAULT_CLASSES
    #: In open mode, empty means every application except those blocked and
    #: non-empty means these and no others. In per-application mode the list
    #: is the whole answer: empty permits nothing.
    applications: frozenset[str] = frozenset()
    blocked_applications: frozenset[str] = frozenset()
    #: What is permitted *inside a particular application*, where the answer is
    #: not the same everywhere. The allow-list above decides whether an
    #: application is reachable at all; this decides how far a client may go
    #: once it is in one — view-only here, interact there — which is a
    #: distinction a single list of names cannot make.
    #:
    #: An entry replaces `classes` for calls against that application, the same
    #: narrow-answer-wins rule a grant's `per_application` follows, capped by
    #: `classes` because a per-application line is a narrowing device and never
    #: a side door. Unlike a grant, naming one application says nothing about
    #: the others: an application with no entry is governed by `classes`, so a
    #: file that pins one application to view-only leaves the rest exactly as
    #: they were.
    application_classes: dict[str, frozenset[str]] = field(default_factory=dict)
    #: Which reading the empty list gets. See PERMISSIONS_MODES.
    permissions_mode: str = OPEN_MODE
    idle_expiry_seconds: float = DEFAULT_IDLE_EXPIRY_SECONDS
    confirm_classes: frozenset[str] = CONFIRM_BY_DEFAULT
    #: Named in every refusal, so a denial is a thing somebody can act on. A
    #: key on its own sends the reader looking for a file; the path is the
    #: difference between "ask your administrator" and "edit this".
    config_key: str = "desktop.scopes"
    config_path: str = ""
    #: Whether that file was there to read. A refusal that says "raise the
    #: ceiling in this file" sends a first-time reader looking for a file that
    #: does not exist, and the obvious conclusion — that they are looking in the
    #: wrong place — is the wrong one.
    config_exists: bool = False

    @property
    def where(self) -> str:
        """How to name this ceiling's source in a refusal."""
        if not self.config_path:
            return self.config_key
        if not self.config_exists:
            return f"{self.config_key} in {self.config_path}, a file that does not exist yet"
        return f"{self.config_key} in {self.config_path}"

    @property
    def how_to_raise(self) -> str:
        """A refusal's last line: what the reader should go and do about it.

        A first run has no configuration at all, and the honest instruction
        there is to write one rather than to edit one. The example is spelled
        out because the alternative is a reader guessing at key names, and a
        guessed key is silently ignored by every JSON reader ever written.
        """
        if not self.config_path:
            return f"Widen {self.config_key}."
        if self.config_exists:
            return f"Widen {self.where}. Nothing reachable over this socket can do it for you."
        return (
            f"Create {self.config_path} containing "
            '{"scopes": {"operationClasses": ["observe", "edit", "activate"]}} '
            "and restart the service. Nothing reachable over this socket can do it for you."
        )

    @classmethod
    def from_config(cls, config: dict | None, path: str = "", exists: bool | None = None) -> "Ceiling":
        config = config or {}
        classes = config.get("operationClasses")
        allowed = frozenset(_normalise(classes)) if classes else DEFAULT_CLASSES
        unknown = allowed - set(OPERATION_CLASSES)
        if unknown:
            raise ValueError(f"unknown operation class in configuration: {sorted(unknown)}")
        mode = str(config.get("permissionsMode", OPEN_MODE)).strip().casefold() or OPEN_MODE
        if mode not in PERMISSIONS_MODES:
            # Loud, like an unknown operation class. A misspelled mode read as
            # "open" would permit everything the user was trying to fence.
            raise ValueError(
                f"unknown permissionsMode in configuration: {mode!r} "
                f"(expected one of {list(PERMISSIONS_MODES)})"
            )
        return cls(
            classes=allowed,
            applications=frozenset(_normalise(config.get("applications", ()))),
            blocked_applications=frozenset(_normalise(config.get("blockedApplications", ()))),
            application_classes=cls._application_classes(config.get("applicationClasses"), allowed),
            permissions_mode=mode,
            idle_expiry_seconds=float(config.get("idleExpirySeconds", DEFAULT_IDLE_EXPIRY_SECONDS)),
            confirm_classes=frozenset(_normalise(config.get("confirmClasses", CONFIRM_BY_DEFAULT))),
            config_path=path,
            config_exists=bool(config) if exists is None else exists,
        )

    @staticmethod
    def _application_classes(config, allowed: frozenset[str]) -> dict[str, frozenset[str]]:
        """Read the per-application map, refusing anything it cannot mean.

        Loud, like an unknown operation class anywhere else in this file. A
        misspelled class name silently dropped would leave a line the user
        believes is a restriction and the service reads as nothing, and a class
        named here that the ceiling does not permit at all is a file
        contradicting itself — the honest answer to both is the error that
        names the application and the word, not a quiet repair.
        """
        if not config:
            return {}
        if not isinstance(config, dict):
            raise ValueError(
                "applicationClasses in configuration must be a map of application "
                f"name to operation classes, not {type(config).__name__}"
            )
        parsed: dict[str, frozenset[str]] = {}
        for name, app_classes in config.items():
            key = str(name).strip().casefold()
            if not key:
                continue
            named = frozenset(_normalise(app_classes))
            unknown = named - set(OPERATION_CLASSES)
            if unknown:
                raise ValueError(
                    f"unknown operation class for {key!r} in applicationClasses: {sorted(unknown)}"
                )
            above = named - allowed
            if above:
                raise ValueError(
                    f"applicationClasses gives {key!r} more than operationClasses allows "
                    f"anywhere: {sorted(above)}"
                )
            parsed[key] = named
        return parsed

    def classes_for(self, application: str) -> frozenset[str] | None:
        """What this configuration permits inside `application`, ladder included.

        `None` means the file said nothing about this application and the
        ceiling's general answer stands. That is the opposite of what `None`
        means from a grant's `hand_in`, and deliberately so: a grant that names
        applications individually has described its whole extent, while this
        map sits behind an allow-list that already decides who is in and who is
        out. Reading an absent entry as a refusal would quietly turn every file
        that pins one application to view-only into a file that shut down every
        other application on the desktop.

        A named entry answers with the ladder filled in — `activate` admits the
        `observe` and `edit` reads an interaction is made of — and then capped
        by `classes`, so the implication can never hand out a class the ceiling
        withholds everywhere. An entry naming nothing at all permits nothing:
        an empty list is a thing the user typed, and the only honest reading of
        it is that they meant it.
        """
        if not application or not self.application_classes:
            return None
        name = application.strip().casefold()
        for pattern, named in self.application_classes.items():
            if pattern in name:
                return implied_classes(named) & self.classes
        return None

    def permits_application(self, application: str) -> bool:
        name = application.strip().casefold()
        if not name:
            # An action with no application attached is not a loophole: it is
            # an action against the desktop itself, and the class rule still
            # applies to it.
            return True
        if any(blocked in name for blocked in self.blocked_applications):
            return False
        if not self.applications:
            # The two readings of an empty list. In per-application mode the
            # user chose checkboxes and checked none of them for this app —
            # including the app installed five minutes ago, which is the case
            # the mode exists for.
            return self.permissions_mode == OPEN_MODE
        return any(allowed in name for allowed in self.applications)

    def permits_weakly_identified_application(self, *candidates: str) -> bool:
        """Whether an application known only by display-server names may be mentioned.

        An application that never joined the accessibility bus has no accessible name,
        so the only names it can be judged by are the ones X11 and `/proc` carry:
        `Google-chrome`, `chrome`. Those are weaker evidence than the name every other
        row in this file is matched on, and the matching therefore errs toward silence.

        Two differences from `permits_application`. Every candidate must clear the
        block list, not just the one that happens to be reported — otherwise the row
        could be named by whichever of its names the configuration failed to mention.
        And the block match runs in both directions: a ceiling blocking
        `google-chrome` must still withhold a window that only calls itself `chrome`,
        or the walled-off browser announces its existence through the very list that
        exists to describe what cannot be read.
        """
        names = [candidate.strip().casefold() for candidate in candidates]
        names = [name for name in names if name]
        if not names:
            # Unlike `permits_application`, silence here is refusal. An action with no
            # application attached is an action against the desktop; a *row* with no
            # name is a row the ceiling cannot judge, and one of those must never be
            # reported at all.
            return False
        for blocked in self.blocked_applications:
            if any(blocked in name or name in blocked for name in names):
                return False
        if not self.applications:
            # Same two readings as `permits_application`, and weakly
            # identified rows get no extra benefit of the doubt.
            return self.permissions_mode == OPEN_MODE
        return any(allowed in name for name in names for allowed in self.applications)


def _normalise(names) -> set[str]:
    return {str(name).strip().casefold() for name in names or () if str(name).strip()}


#: The prefixes the backend mints ids with. An anchor whose target carries one
#: is matched exactly: an id is minted rather than typed, so a substring of one
#: is a coincidence and never an intention. Anything else is an application
#: name, matched as a substring — which is how applications are named
#: everywhere else in this file, and in the configuration the ceiling reads.
_MINTED_PREFIXES: tuple[str, ...] = ("el-", "win-", "app-")


@dataclass(frozen=True)
class Anchor:
    """A place in the tree, and what may be done there.

    An application is one place a permission can hang, but it is not the only
    one, and it is rarely the one a task means. "Fill in this form" is a
    sentence about a form, and expressing it as "edit anything in the browser"
    is a widening the task never asked for. An anchor lets the grant say the
    narrow thing: this window, this element, and — if `covers_descendants` —
    what is inside it.
    """

    target: str
    classes: frozenset[str] = frozenset()
    #: Whether this anchor speaks for the subtree under it, or only for the one
    #: node it names. Off by default: a grant on a single field that silently
    #: reached everything beneath it would be the widening anchors exist to
    #: prevent, and a form has fields inside fields.
    covers_descendants: bool = False

    def covers(self, identifier: str, *, descendant: bool) -> bool:
        if descendant and not self.covers_descendants:
            return False
        target = self.target.strip().casefold()
        if not target:
            return False
        if target.startswith(_MINTED_PREFIXES):
            return target == identifier
        # A typed name never matches a minted id, even as a substring of one.
        # The ancestry carries both, and an application named "win" would
        # otherwise cover every window on the desktop by spelling.
        if identifier.startswith(_MINTED_PREFIXES):
            return False
        return target in identifier


@dataclass
class Grant:
    """What one client currently holds. Mutable, because it expires."""

    classes: frozenset[str] = DEFAULT_CLASSES
    applications: frozenset[str] = frozenset()
    #: What this client holds *in a particular application*, when the answer is
    #: not the same everywhere. A task that reads notes from an editor and sends
    #: them from a browser needs to submit in one of those and never in the
    #: other; a single class set applied to a list of names cannot say that, and
    #: quietly hands the editor a permission the task never asked for.
    #:
    #: An entry here replaces `classes` for calls against that application rather
    #: than adding to it, so the narrow answer wins where there is one.
    per_application: dict[str, frozenset[str]] = field(default_factory=dict)
    #: Places in the tree this grant hangs on, nearest-wins. The generalisation
    #: of `per_application`: an application is the outermost anchor there is,
    #: and everything narrower than one used to have nowhere to be written down.
    anchors: tuple[Anchor, ...] = ()
    granted_at: float = 0.0
    last_used_at: float = 0.0
    #: How long the grant survives *without use*. Idle expiry, not a lifetime:
    #: a grant that expired mid-task while being used every second would be an
    #: absolute deadline wearing the word "idle", and the client would discover
    #: the difference halfway through a sentence.
    idle_seconds: float = 0.0
    reason: str = ""
    #: The criteria a commit made under this grant is judged against, declared
    #: here rather than at the call for the same reason the scope is: the thing
    #: being judged does not write its own rubric. A worker cannot reach this —
    #: it is set when the door is opened, by whoever opened it — and the
    #: service's mechanical criteria are evaluated on top of it regardless, so
    #: declaring nothing weakens nothing.
    criteria: tuple[str, ...] = ()

    def is_expired(self, now: float) -> bool:
        return bool(self.idle_seconds) and (now - self.last_used_at) >= self.idle_seconds

    def hand_in(self, application: str) -> frozenset[str] | None:
        """What this client holds against `application`, or None if it holds nothing.

        None is a refusal, not an absence of opinion: once a grant names
        applications individually, the ones it did not name are outside it. A
        grant that fell back to its general hand for unnamed applications would
        make the per-application form a suggestion.

        An empty application is the desktop itself rather than a thing inside it
        — listing windows, asking the revision — and answers from the general
        hand.
        """
        if not application:
            return self.classes
        name = application.strip().casefold()
        for pattern, classes in self.per_application.items():
            if pattern in name:
                return classes | DEFAULT_CLASSES
        if self.per_application:
            return None
        if self.applications and not any(allowed in name for allowed in self.applications):
            return None
        return self.classes

    def classes_at(self, ancestry) -> frozenset[str] | None:
        """What this client holds at a place in the tree, or None if it holds nothing.

        `ancestry` runs nearest-first: the target itself, then its parents, then
        the window, then the application. The nearest anchor covering the target
        wins, which is the rule filesystem permissions have used for decades —
        an entry deeper in the tree is a more specific statement than one above
        it, and the more specific statement is the one that was meant. So a
        subtree granted observe with one field inside it granted edit composes
        without either rule having to know about the other: the field is nearer.

        The target itself is covered by an anchor naming it whether or not that
        anchor covers descendants — an anchor on a node always speaks for that
        node. Only the walk upward asks about descendants.

        None is a refusal, for the same reason `hand_in` refuses an unnamed
        application: a grant that named the places it applies to has said what it
        does not cover, and falling back to the general hand outside them would
        make the anchor a suggestion.
        """
        for step, identifier in enumerate(ancestry):
            name = str(identifier).strip().casefold()
            if not name:
                continue
            for anchor in self.anchors:
                if anchor.covers(name, descendant=step > 0):
                    return anchor.classes | DEFAULT_CLASSES
        return None

    def classes_anywhere(self) -> frozenset[str]:
        """Everything this grant permits at any of the places it hangs.

        For the one call that has no place of its own: a batch reaches the
        desktop only through its steps, and each step is checked at its own
        place before any of them runs. Asking the batch itself "may you submit
        here" has no *here* to answer about, and answering from the general hand
        would refuse every batch an anchored grant could ever legitimately
        make — which would push clients back to asking for the class across the
        whole desktop, the widening anchors exist to avoid.

        It is a gate rather than the decision: passing it says only that this
        grant submits somewhere. Where, is a question the steps answer.
        """
        return self.classes.union(*(anchor.classes for anchor in self.anchors))


class AnchorUnresolved(DesktopError):
    """A grant hung on a place that is no longer there.

    Not a permission answer, which is the point. The client asked to act
    somewhere its grant no longer describes, and the honest report is that the
    reference died rather than that the action was refused: one of those is
    fixed by re-reading the window and asking again, and the other is not. It
    reuses the stale-reference code because that is the same event a stale
    element id reports, and the client already knows how to recover from it.
    """

    def __init__(self, target: str, ambiguous: bool = False) -> None:
        why = (
            "it now matches more than one thing, so which one it meant is no longer knowable"
            if ambiguous
            else "the place it named is no longer there"
        )
        super().__init__(
            ErrorCode.ELEMENT_REFERENCE_STALE,
            f"This client's grant is anchored to {target!r}, and {why}. "
            "An anchor that cannot be resolved grants nothing.",
            {
                "anchor": target,
                "hint": (
                    "Re-read the window and ask for the scope again against what is "
                    "there now. Nothing was revoked; the tree moved."
                ),
            },
        )


@dataclass(frozen=True)
class Decision:
    """The answer, and enough of the reasoning to write it in the audit log.

    A decision object rather than a boolean because the audit record has to say
    why, and reconstructing the why at the logging site means writing the rule
    down twice.
    """

    allowed: bool
    method: str
    operation_class: str
    client_id: str
    reason: str
    application: str = ""
    #: When set, the denial is raised as this error code instead of
    #: PERMISSION_DENIED. An out-of-scope application must be indistinguishable
    #: from one that was never real: a refusal names the thing refused, and
    #: naming it confirms it exists. The disguise carries a generic message so
    #: neither the error code nor its text leaks the target.
    disguised_as: str = ""
    #: The answer the *client author* gets: the application, and which rule
    #: refused. It goes to the service's own log, which is the one channel the
    #: agent has no method for — `auditTail` is a tool, and a diagnostic written
    #: there would be the leak this disguise exists to close. Without this, a
    #: developer whose config is wrong sees an agent reporting that their
    #: browser does not exist, and nothing anywhere says otherwise.
    diagnostic: str = ""

    def raise_for_denial(self, ceiling: Ceiling, granted: frozenset[str]) -> None:
        if self.allowed:
            return
        if self.disguised_as:
            if self.diagnostic:
                log.warning(
                    "refused %s for client %r and told it nothing exists: %s",
                    self.method,
                    self.client_id,
                    self.diagnostic,
                )
            raise DesktopError(self.disguised_as, self.reason, {})
        raise PermissionDenied(
            self.reason,
            method=self.method,
            required=self.operation_class,
            granted=tuple(sorted(granted)),
            application=self.application,
            remedy=(
                f"Ask for it with grantScope. If the ceiling is what refused you: "
                f"{ceiling.how_to_raise}"
            ),
        )


class Consent:
    """The grants held by every client attached to this service.

    One per service process, alongside the element registry and the revision
    counter, because clients share those too and a permission that differed
    from the thing it protects would be worse than no permission at all.
    """

    def __init__(self, ceiling: Ceiling | None = None, *, now=time.monotonic) -> None:
        self._ceiling = ceiling or Ceiling()
        self._now = now
        self._grants: dict[str, Grant] = {}
        self._stopped = False
        self._stopped_reason = ""

    @property
    def ceiling(self) -> Ceiling:
        return self._ceiling

    def reload_ceiling(self, ceiling: Ceiling) -> None:
        """Install a ceiling re-read from the user's file.

        The file is still the only author — this exists so a saved edit takes
        effect without a restart, not so a caller can hand one in: nothing
        reachable over the socket calls this. Grants already issued are left
        alone; every visibility and permission check reads the ceiling live,
        so a shrunken ceiling bites immediately even under an older grant.
        """
        self._ceiling = ceiling

    @property
    def stopped(self) -> bool:
        return self._stopped

    def grant_of(self, client_id: str) -> Grant:
        return self._grants.get(client_id) or Grant()

    def grant(
        self,
        client_id: str,
        *,
        classes,
        applications=(),
        per_application: dict[str, object] | None = None,
        anchors=(),
        seconds: float | None = None,
        reason: str = "",
        criteria: Sequence[str] = (),
    ) -> Grant:
        """Narrow a client's hand within the ceiling. Never widen the ceiling.

        Emergency stop is not undone by asking again: a stop revokes everything
        and refuses to issue anything until it is explicitly cleared, because a
        client that could grant its way out of a stop makes the stop a
        suggestion.
        """
        if self._stopped:
            raise PermissionDenied(
                "Emergency stop is in effect: no scope can be granted until it is cleared. "
                f"({self._stopped_reason})" if self._stopped_reason else
                "Emergency stop is in effect: no scope can be granted until it is cleared.",
                method="grantScope",
                remedy="Clear the stop deliberately; it does not time out on its own.",
            )
        scoped = {
            str(app).strip().casefold(): frozenset(_normalise(app_classes))
            for app, app_classes in (per_application or {}).items()
            if str(app).strip()
        }
        hung = tuple(
            Anchor(
                target=str(anchor.target).strip().casefold(),
                classes=frozenset(_normalise(anchor.classes)),
                covers_descendants=bool(anchor.covers_descendants),
            )
            for anchor in anchors or ()
        )
        if any(not anchor.target for anchor in hung):
            raise ScopeError(
                "An anchor must name the place it hangs on.",
                method="grantScope",
                remedy=(
                    "Give each anchor a target: an element id, a window id, or an "
                    "application name. An anchor that names nothing covers nothing, "
                    "and a grant that appears to have been issued and then refuses "
                    "everything it covers is a grant somebody debugs for an hour."
                ),
            )
        # Every class named anywhere in this grant faces the ceiling, including
        # the ones only named against a single application or a single element.
        # A per-application entry and an anchor are both narrowing devices,
        # never side doors around the ceiling.
        wanted = (
            frozenset(_normalise(classes))
            | frozenset().union(*scoped.values(), frozenset())
            | frozenset().union(*(anchor.classes for anchor in hung), frozenset())
        )
        unknown = wanted - set(OPERATION_CLASSES)
        if unknown:
            raise ScopeError(
                f"No such operation class: {', '.join(sorted(unknown))}",
                method="grantScope",
                remedy=f"Operation classes are {', '.join(OPERATION_CLASSES)}.",
            )
        above = wanted - self._ceiling.classes
        if above:
            raise ScopeError(
                "That is more than this desktop's configuration allows: "
                f"{', '.join(sorted(above))} is above the ceiling.",
                method="grantScope",
                required=", ".join(sorted(above)),
                granted=tuple(sorted(self._ceiling.classes)),
                remedy=self._ceiling.how_to_raise,
            )
        # A per-application entry asks about one application by name, so the
        # file's answer about that application is available here and the
        # refusal belongs here too: a grant issued saying `activate` in an
        # application the configuration holds at view-only is a grant that
        # refuses everything it appears to cover, which is a grant somebody
        # debugs for an hour. The general classes are not held to this — they
        # apply everywhere, and the file narrowing one application is the
        # narrowing working, not a contradiction. Anchors are caught in
        # `decide`, where the target's own application is known.
        for app, app_classes in scoped.items():
            permitted_there = self._ceiling.classes_for(app)
            if permitted_there is None:
                continue
            above_there = frozenset(app_classes) - permitted_there
            if above_there:
                raise ScopeError(
                    "That is more than this desktop's configuration allows in "
                    f"{app}: {', '.join(sorted(above_there))} is above the ceiling there.",
                    method="grantScope",
                    required=", ".join(sorted(above_there)),
                    granted=tuple(sorted(permitted_there)),
                    remedy=self._ceiling.how_to_raise,
                )
        apps = frozenset(_normalise(applications)) | frozenset(scoped)
        # An anchor that names an application faces the same door as any other
        # way of naming one. An anchor onto an id cannot be checked here — the
        # id means nothing without the tree, and resolving it at grant time
        # would answer a question about a desktop that may have moved on by the
        # time the grant is used. That one is caught where it matters: `decide`
        # puts the target's own application against the ceiling before it ever
        # looks at an anchor, so no anchor reaches into a walled-off
        # application no matter what it names.
        named = {
            anchor.target
            for anchor in hung
            if not anchor.target.startswith(_MINTED_PREFIXES)
        }
        refused = {
            app for app in apps | named if not self._ceiling.permits_application(app)
        }
        if refused:
            raise ScopeError(
                f"This desktop's configuration does not allow acting on: {', '.join(sorted(refused))}",
                method="grantScope",
                remedy=f"Change {self._ceiling.where}; a grant cannot reach past it.",
            )
        now = self._now()
        window = float(seconds if seconds is not None else self._ceiling.idle_expiry_seconds)
        issued = Grant(
            classes=frozenset(_normalise(classes)) | DEFAULT_CLASSES,
            applications=apps,
            per_application=scoped,
            anchors=hung,
            granted_at=now,
            last_used_at=now,
            idle_seconds=window,
            reason=reason,
            criteria=tuple(
                str(name).strip()
                for name in (criteria or ())
                if str(name).strip()
            ),
        )
        self._grants[client_id] = issued
        return issued

    def criteria_for(self, client_id: str) -> tuple[attestation.Criterion, ...]:
        """The rubric declared for this client, mechanical criteria included.

        A client with no grant gets the mechanical set, which is the honest
        answer: the questions the service can decide alone are asked of every
        commit, and holding no grant is not a reason to ask fewer of them.
        """
        return attestation.resolve(self.grant_of(client_id).criteria)

    def revoke(self, client_id: str) -> None:
        self._grants.pop(client_id, None)

    def emergency_stop(self, reason: str = "") -> int:
        """Revoke everything, and keep refusing until this is cleared.

        What it cannot do is take back an action already handed to a toolkit.
        There is no un-click, and a stop that implied otherwise would be worse
        than no stop, because someone would rely on it.

        It needs no grant to pull, which is deliberate: a stop you need
        permission to pull is not a stop. It also revokes grants belonging to
        clients that did not pull it, which was accepted for one reason only —
        the only thing that could reach this socket was on the same single-user
        machine, so the worst case was a person interrupting themselves. A
        client holding a server URL and a credential is not on that machine.
        That makes this a blocker on any network-facing layer rather than the
        documented trade-off it was recorded as, and the rule that replaces it
        cannot be written until it is settled whether one server serves one
        person or several. Today's behaviour is asserted by
        `tests/test_connections.py::test_a_stop_pulled_on_one_connection_revokes_the_others_grant`
        so that changing it has to be a decision.
        """
        revoked = len(self._grants)
        self._grants.clear()
        self._stopped = True
        self._stopped_reason = reason
        return revoked

    def clear_stop(self) -> None:
        self._stopped = False
        self._stopped_reason = ""

    @staticmethod
    def _refuse_dead_anchors(grant: Grant, anchor_lives) -> None:
        """Raise if any anchor this grant hangs on has stopped resolving.

        Asked in tree order rather than grant order is not worth the
        complication: a grant hangs on a handful of places, and the first dead
        one is enough to say the grant no longer describes the desktop it was
        issued against.
        """
        if anchor_lives is None:
            return
        for anchor in grant.anchors:
            alive = anchor_lives(anchor.target)
            if alive is None:
                # None is the answer `rediscover` gives when two things match:
                # a reference that could mean either is not a reference. It is
                # treated as unresolved rather than resolved-to-one, because
                # handing back "one of them" is how a permission ends up
                # applied to the wrong field.
                raise AnchorUnresolved(anchor.target, ambiguous=True)
            if not alive:
                raise AnchorUnresolved(anchor.target)

    def decide(
        self,
        *,
        method: str,
        operation_class: str,
        client_id: str,
        application: str = "",
        ancestry=(),
        names_a_place: bool = False,
        anchor_lives=None,
        reaches_through_steps: bool = False,
        confirmed: bool = False,
    ) -> Decision:
        """Whether this call may proceed, and why.

        Observation is allowed to an ungranted client and is still refused
        against a blocked application: a window the user has walled off is not
        visible, rather than visible-but-unactionable. Reading a password
        manager's window is the thing being prevented, not clicking in it.

        `ancestry` is where the target sits in the tree, nearest-first, and is
        consulted only by a grant that hung itself somewhere — a grant with no
        anchors costs exactly what it cost before. `names_a_place` says the call
        was about somewhere rather than about the desktop, and is separate from
        the ancestry because a target that named a place and could not be found
        in the tree must not be answered as though it had named none.
        `anchor_lives` answers
        whether a target still resolves; it is asked for only when a grant with
        anchors covers nothing here, which is the one case where the difference
        between "not allowed there" and "there is gone" changes the answer.
        `reaches_through_steps` marks the call that has no place of its own
        because it carries other calls inside it.
        """
        allow = lambda reason: Decision(True, method, operation_class, client_id, reason, application)
        deny = lambda reason, disguised_as="", diagnostic="": Decision(
            False, method, operation_class, client_id, reason, application, disguised_as, diagnostic
        )

        if self._stopped and operation_class != "observe":
            return deny(
                "Emergency stop is in effect: this service is refusing everything except observation."
                + (f" ({self._stopped_reason})" if self._stopped_reason else "")
            )
        if application and not self._ceiling.permits_application(application):
            return deny(
                "No application matching that target was found.",
                disguised_as=ErrorCode.APPLICATION_NOT_FOUND,
                diagnostic=(
                    f"this desktop's configuration does not expose {application!r} to any client"
                ),
            )

        grant = self._grants.get(client_id)
        now = self._now()
        if grant and grant.is_expired(now):
            idle_for = now - grant.last_used_at
            self._grants.pop(client_id, None)
            grant = None
            if operation_class != "observe":
                raise SessionExpired(
                    "This client's grant expired; ask for it again.",
                    idle_seconds=idle_for,
                    remedy="Call grantScope. Nothing was revoked in anger — it simply timed out.",
                )
        # What is held here, rather than what is held in general: a grant can say
        # different things about different places, and the question is always
        # about the one being touched.
        # A call is about a place if the tree could put it in one, or if it named
        # one the tree could not find — the second is not the same as a call
        # about the desktop, and must not be answered as though it were.
        about_a_place = bool(ancestry) or names_a_place
        if grant and grant.anchors and reaches_through_steps and not about_a_place:
            # A batch names no place of its own. Its steps do, and every one of
            # them is decided here too, at its own place, before any of them
            # runs.
            held = grant.classes_anywhere()
        elif grant and grant.anchors and about_a_place:
            # An empty ancestry here is a target the tree could not place, which
            # is not the same as a target nothing covers — but it is answered
            # the same way, because an anchored grant that cannot be told where
            # it is being used has nothing to say except no.
            held = grant.classes_at(ancestry)
            if held is None:
                # Before refusing, find out whether there is anything left to
                # refuse. A grant anchored to a dialog that has since closed
                # would otherwise report a permission problem for the rest of
                # the session, and the client would ask for the same scope again
                # and be refused again, because the answer it needed was that
                # the place is gone.
                self._refuse_dead_anchors(grant, anchor_lives)
                return deny(
                    f"{method} is a {operation_class!r} operation and this client's "
                    "grant does not hang anywhere over this target. It is anchored to "
                    f"{', '.join(sorted(anchor.target for anchor in grant.anchors))}."
                )
        else:
            held = grant.hand_in(application) if grant else DEFAULT_CLASSES
        if held is None:
            covers = sorted(grant.per_application) or sorted(grant.applications)
            return deny(
                "No application matching that target was found.",
                disguised_as=ErrorCode.APPLICATION_NOT_FOUND,
                diagnostic=(
                    f"this client's grant covers {', '.join(covers) or 'nothing'}, "
                    f"not {application!r}"
                ),
            )

        # The configuration's answer for this application, checked separately
        # from the grant's so that the refusal can say which of the two
        # refused. A client told it "holds observe" when the file is what
        # pinned the application to view-only would go and ask for a wider
        # grant, be given one, and be refused again in exactly the same place.
        permitted_here = self._ceiling.classes_for(application)
        if permitted_here is not None and operation_class not in permitted_here:
            return deny(
                f"{method} is a {operation_class!r} operation and this desktop's "
                f"configuration permits {', '.join(sorted(permitted_here)) or 'nothing'} "
                f"in {application!r}."
            )
        if operation_class not in held:
            where = f" in {application!r}" if application and grant and grant.per_application else ""
            return deny(
                f"{method} is a {operation_class!r} operation and this client holds "
                f"{', '.join(sorted(held))}{where}."
            )
        if operation_class in self._ceiling.confirm_classes and not confirmed:
            return deny(
                f"{method} is a {operation_class!r} operation and needs confirm: true. "
                "The flag is how a caller says it meant this one, rather than having meant "
                "the whole class once."
            )
        if grant:
            self._grants[client_id] = replace(grant, last_used_at=now)
        return allow("granted")

    def enforce(self, **kwargs) -> Decision:
        """decide(), and raise if the answer was no."""
        decision = self.decide(**kwargs)
        decision.raise_for_denial(self._ceiling, self.grant_of(kwargs.get("client_id", "")).classes)
        return decision
