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

import time
from dataclasses import dataclass, field, replace

from . import protocol_generated
from .errors import PermissionDenied, SessionExpired

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


def breadth_of(grant: "Grant", ceiling: "Ceiling") -> dict:
    """How wide a net this grant casts.

    applications is the count of distinct application identities the grant
    could act against. anchors is the count of element-anchored permissions
    (zero until scope anchors ship). Until anchors exist this is an
    application-spread proxy, explicitly so it cannot silently overstate.

    A grant that names no applications inherits the ceiling's list, and a
    ceiling that names none means every application there is. Reporting that
    as zero would read as the narrowest possible scope when it is the widest
    one available, so it is counted and flagged rather than summed: the count
    is what is nameable, `unbounded` is the warning that the real number is
    however many applications happen to be running.
    """
    apps = set(grant.applications) | set(grant.per_application.keys())
    if apps:
        return {"applications": len(apps), "anchors": 0, "unbounded": False}
    return {
        "applications": len(ceiling.applications),
        "anchors": 0,
        "unbounded": not ceiling.applications,
    }


class ScopeError(PermissionDenied):
    """Raised when a caller asks for more than the configuration allows."""


@dataclass(frozen=True)
class Ceiling:
    """The most any client may ever be granted, from the user's configuration.

    Read once at startup from a file the user owns. Nothing over the socket
    writes to this — that is the entire point of it being a separate object
    from the grant.
    """

    classes: frozenset[str] = DEFAULT_CLASSES
    #: Empty means every application except those blocked. Non-empty means
    #: these and no others, which is the shape a careful user wants.
    applications: frozenset[str] = frozenset()
    blocked_applications: frozenset[str] = frozenset()
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
        return cls(
            classes=allowed,
            applications=frozenset(_normalise(config.get("applications", ()))),
            blocked_applications=frozenset(_normalise(config.get("blockedApplications", ()))),
            idle_expiry_seconds=float(config.get("idleExpirySeconds", DEFAULT_IDLE_EXPIRY_SECONDS)),
            confirm_classes=frozenset(_normalise(config.get("confirmClasses", CONFIRM_BY_DEFAULT))),
            config_path=path,
            config_exists=bool(config) if exists is None else exists,
        )

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
            return True
        return any(allowed in name for allowed in self.applications)


def _normalise(names) -> set[str]:
    return {str(name).strip().casefold() for name in names or () if str(name).strip()}


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
    granted_at: float = 0.0
    last_used_at: float = 0.0
    #: How long the grant survives *without use*. Idle expiry, not a lifetime:
    #: a grant that expired mid-task while being used every second would be an
    #: absolute deadline wearing the word "idle", and the client would discover
    #: the difference halfway through a sentence.
    idle_seconds: float = 0.0
    reason: str = ""

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

    def raise_for_denial(self, ceiling: Ceiling, granted: frozenset[str]) -> None:
        if self.allowed:
            return
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
        seconds: float | None = None,
        reason: str = "",
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
        # Every class named anywhere in this grant faces the ceiling, including
        # the ones only named against a single application. A per-application
        # entry is a narrowing device, never a side door around the ceiling.
        wanted = frozenset(_normalise(classes)) | frozenset().union(*scoped.values(), frozenset())
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
        apps = frozenset(_normalise(applications)) | frozenset(scoped)
        refused = {app for app in apps if not self._ceiling.permits_application(app)}
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
            granted_at=now,
            last_used_at=now,
            idle_seconds=window,
            reason=reason,
        )
        self._grants[client_id] = issued
        return issued

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

    def decide(
        self,
        *,
        method: str,
        operation_class: str,
        client_id: str,
        application: str = "",
        confirmed: bool = False,
    ) -> Decision:
        """Whether this call may proceed, and why.

        Observation is allowed to an ungranted client and is still refused
        against a blocked application: a window the user has walled off is not
        visible, rather than visible-but-unactionable. Reading a password
        manager's window is the thing being prevented, not clicking in it.
        """
        allow = lambda reason: Decision(True, method, operation_class, client_id, reason, application)
        deny = lambda reason: Decision(False, method, operation_class, client_id, reason, application)

        if self._stopped and operation_class != "observe":
            return deny(
                "Emergency stop is in effect: this service is refusing everything except observation."
                + (f" ({self._stopped_reason})" if self._stopped_reason else "")
            )
        if application and not self._ceiling.permits_application(application):
            return deny(
                f"This desktop's configuration does not expose {application!r} to a client."
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
        # different things about different applications, and the question is
        # always about the one being touched.
        held = grant.hand_in(application) if grant else DEFAULT_CLASSES
        if held is None:
            covers = sorted(grant.per_application) or sorted(grant.applications)
            return deny(
                f"This client's grant covers {', '.join(covers)}, not {application!r}."
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
