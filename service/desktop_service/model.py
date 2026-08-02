"""The unified semantic element model, and the single point every value leaves by.

Two things live here and they are deliberately in the same file.

The first is `SemanticElement` — one shape for an element regardless of which
backend produced it. It does not flatten backends to a lowest common
denominator: a backend that knows more puts the surplus in `extra` under its own
namespace rather than throwing it away.

The second is the **value-egress point**. Every element name and value that
leaves a backend passes through `egress_value`. Today it is a pass-through with a
policy hook. It exists this early because a later segment has to guarantee that a
password never reaches a method result, a delta payload, a signal payload or the
audit log — and the delta and signal payloads get written before that segment
starts. One choke point declared now is a policy change later; discovering the
need afterwards is an audit of every path that ever touched a value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

# Fields that carry human-readable text out of a backend. A policy sees the
# field name so it can treat a value differently from a label.
NAME = "name"
VALUE = "value"
EXTRA = "extra"
#: A window title is text the user typed somewhere — a document name, a chat
#: partner, a subject line. It leaves by the same door as element text.
TITLE = "title"
APPLICATION_NAME = "applicationName"
#: A change summary quotes the things it describes, so it inherits their sensitivity.
#: A delta that narrated a password field's new contents would make every other
#: precaution in this file pointless.
SUMMARY = "summary"


@dataclass(frozen=True)
class ValueContext:
    """Everything a policy needs to decide what to do with a piece of text.

    A redaction policy cannot work from the text alone — "hunter2" is a password
    in a password field and a perfectly good message in a chat window. The role
    and states are what make the decision possible, so they are part of the
    contract from the start rather than added when redaction lands.
    """

    text: str
    field: str
    role: str
    states: tuple[str, ...] = ()
    element_id: str = ""
    application: str = ""


# A policy returns the text to emit. Returning a different string redacts;
# returning the input passes it through.
ValuePolicy = Callable[[ValueContext], str]


def _passthrough(context: ValueContext) -> str:
    return context.text


_policy: ValuePolicy = _passthrough


def set_value_policy(policy: ValuePolicy | None) -> ValuePolicy:
    """Install the egress policy, returning the previous one.

    Passing `None` restores the pass-through. Tests use the return value to put
    the previous policy back rather than assuming what it was.
    """
    global _policy
    previous = _policy
    _policy = policy or _passthrough
    return previous


def get_value_policy() -> ValuePolicy:
    return _policy


def egress_value(
    text: str | None,
    *,
    field: str,
    role: str = "",
    states: tuple[str, ...] | list[str] = (),
    element_id: str = "",
    application: str = "",
) -> str:
    """The one door element text leaves by.

    `None` is normalised to the empty string here so that no caller has to decide
    whether an absent value is worth sending through the policy — an absent value
    is not text, and a policy never sees one.
    """
    if not text:
        return ""
    return _policy(
        ValueContext(
            text=text,
            field=field,
            role=role,
            states=tuple(states),
            element_id=element_id,
            application=application,
        )
    )


@dataclass
class SemanticElement:
    """One element, as the agent sees it.

    `backend_reference` is opaque to the caller and meaningful only to the
    backend that minted it. The caller addresses elements by `id`; the reference
    is what lets the service find the object again without a lookup table that
    would go stale on its own.
    """

    id: str
    backend: str
    role: str
    name: str = ""
    value: str = ""
    states: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    bounds: dict[str, int] | None = None
    children: list["SemanticElement"] = field(default_factory=list)
    backend_reference: dict[str, Any] = field(default_factory=dict)
    # Backend-specific surplus, namespaced by backend name so two backends can
    # both contribute without colliding: {"atspi": {...}}.
    extra: dict[str, Any] = field(default_factory=dict)
    # Set when this node's children were cut short by a bound. A caller that
    # sees this knows the tree is partial rather than the element being childless.
    truncated: bool = False

    def __post_init__(self) -> None:
        """Apply the egress policy to every piece of text this element carries.

        Enforced here rather than at each construction site because a construction
        site can be forgotten, called with positional arguments, or grow a new
        text-bearing field. Inside the constructor there is no way to build one of
        these that skipped the policy — which is the property segment 3's
        redaction guarantee actually needs.
        """
        self.name = egress_value(
            self.name,
            field=NAME,
            role=self.role,
            states=self.states,
            element_id=self.id,
        )
        self.value = egress_value(
            self.value,
            field=VALUE,
            role=self.role,
            states=self.states,
            element_id=self.id,
        )
        if self.extra:
            self.extra = self._egress_extra(self.extra)

    def _egress_extra(self, value: Any) -> Any:
        """Backend surplus is text too, so it leaves by the same door.

        Walked rather than passed whole: a backend is free to nest, and an
        unwalked branch is exactly where a password would sit unnoticed.
        """
        if isinstance(value, str):
            return egress_value(
                value,
                field=EXTRA,
                role=self.role,
                states=self.states,
                element_id=self.id,
            )
        if isinstance(value, dict):
            return {key: self._egress_extra(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._egress_extra(item) for item in value]
        return value

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "backend": self.backend,
            "role": self.role,
            "name": self.name,
            "states": self.states,
            "actions": self.actions,
        }
        if self.value:
            payload["value"] = self.value
        if self.bounds is not None:
            payload["bounds"] = self.bounds
        if self.children:
            payload["children"] = [child.to_json() for child in self.children]
        if self.extra:
            payload["extra"] = self.extra
        if self.truncated:
            payload["truncated"] = True
        return payload

    def walk(self):
        """Depth-first over this element and its descendants."""
        yield self
        for child in self.children:
            yield from child.walk()
