"""What one application actually exposes, measured rather than assumed.

Every claim in the compatibility matrix comes from this module running against a
live application. Nothing in it is hand-typed, because a hand-typed matrix
describes the toolkit the author remembers rather than the one installed.

The probe answers six questions per application, and each one is a thing the
rest of the service depends on: which AT-SPI interfaces it advertises, how deep
its tree can actually be walked, whether `Collection` filtering works, how many
actions its frames expose, how many of the elements *inside* those frames expose
actions, and whether an editable text field exists to write to.

Frames and elements are counted separately because they are different findings
and were once confused for each other. GTK4 puts an application's whole command
set on the frame and leaves the tree empty; Qt does the reverse. Measuring only
the frame reads the second case as an application with nothing to invoke, which
is a statement about the instrument rather than about the application.

It never fails. An application that answers nothing is a *result* — the honest
one — and a probe that raised on the difficult applications would only ever
describe the easy ones.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .backends import atspi as backend

#: Deep enough to reach a document's contents in the applications that have one,
#: shallow enough that an application with a pathological tree cannot hold the
#: probe forever. A tree that hits this reports `depth_limited`, which is a
#: measurement rather than a failure.
MAX_PROBE_DEPTH = 12

#: A walk is a measurement, not an inventory. Past this many nodes the shape of
#: the tree is established and the remainder is more of the same.
MAX_PROBE_NODES = 600

#: Roles that accept typed text. Kept separate from the backend's
#: `TEXT_VALUE_ROLES`, which answers "does this element carry a value worth
#: reading"; this one answers "could an agent type here".
EDITABLE_ROLES = frozenset(
    {"entry", "text", "password text", "document text", "spin button", "combo box"}
)

#: How many action-bearing elements are asked for their action *names*. The count
#: is taken from every node; the names are evidence, and a handful of them says
#: what kind of surface this is without paying a round trip per action per node.
MAX_SAMPLED_ACTION_ELEMENTS = 5

#: Upper bound on the distinct `role: action` strings kept as that evidence.
MAX_SAMPLED_ACTIONS = 8


@dataclass
class ApplicationProbe:
    """One application's measured surface."""

    application_id: str
    name: str
    pid: int = 0
    toolkit: str = ""
    toolkit_version: str = ""
    interfaces: list[str] = field(default_factory=list)
    window_count: int = 0
    #: Deepest level reached before running out of tree or hitting the bound.
    reachable_depth: int = 0
    node_count: int = 0
    depth_limited: bool = False
    node_limited: bool = False
    #: True when the `Collection` interface is advertised *and* a query through
    #: it returned. Advertising it is not the same as answering with it.
    collection_advertised: bool = False
    collection_works: bool = False
    frame_action_count: int = 0
    frame_actions: list[str] = field(default_factory=list)
    #: Elements *below* the frame that expose at least one action. A toolkit that
    #: puts nothing on the frame and everything on its widgets reads as zero in
    #: the field above and as its real surface here.
    actionable_elements: int = 0
    #: A bounded sample of `role: action` strings from those elements, so a count
    #: of them can be checked against what they actually are.
    element_actions: list[str] = field(default_factory=list)
    #: Elements asked for their action names so far, bounding the sample's cost.
    sampled_action_elements: int = 0
    editable_fields: int = 0
    #: Set when the walk stopped early because a call raised or returned nothing.
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "applicationId": self.application_id,
            "name": self.name,
            "pid": self.pid,
            "toolkit": self.toolkit,
            "toolkitVersion": self.toolkit_version,
            "interfaces": sorted(self.interfaces),
            "windowCount": self.window_count,
            "reachableDepth": self.reachable_depth,
            "nodeCount": self.node_count,
            "depthLimited": self.depth_limited,
            "nodeLimited": self.node_limited,
            "collectionAdvertised": self.collection_advertised,
            "collectionWorks": self.collection_works,
            "frameActionCount": self.frame_action_count,
            "frameActions": self.frame_actions,
            "actionableElements": self.actionable_elements,
            "elementActions": self.element_actions,
            "editableFields": self.editable_fields,
            "notes": self.notes,
        }


def _sample_actions(obj: Any, role: str, result: ApplicationProbe) -> None:
    """Keep a few action names as evidence for the count, and then stop asking."""

    if result.sampled_action_elements >= MAX_SAMPLED_ACTION_ELEMENTS:
        return
    result.sampled_action_elements += 1
    for name in backend.actions_of(obj):
        described = f"{role or 'node'}: {name}"
        if described not in result.element_actions:
            if len(result.element_actions) >= MAX_SAMPLED_ACTIONS:
                return
            result.element_actions.append(described)


def _walk(root: Any, result: ApplicationProbe) -> None:
    """Breadth-first, bounded, measuring how far the tree can be followed.

    Breadth-first on purpose: an application that exposes a wide shallow tree and
    an application that exposes one deep spine are different findings, and a
    depth-first walk that spent its whole node budget in the first branch would
    report them the same way.
    """

    frontier = [(root, 0)]
    while frontier:
        obj, depth = frontier.pop(0)
        result.node_count += 1
        result.reachable_depth = max(result.reachable_depth, depth)

        role = backend.role_of(obj)
        if role in EDITABLE_ROLES:
            result.editable_fields += 1

        # The frame is measured separately, by its caller, and counting it here
        # too would report a GTK4 menu twice under two different names.
        if depth > 0 and backend.action_count_of(obj) > 0:
            result.actionable_elements += 1
            _sample_actions(obj, role, result)

        if result.node_count >= MAX_PROBE_NODES:
            result.node_limited = True
            return
        if depth >= MAX_PROBE_DEPTH:
            result.depth_limited = True
            continue

        children = backend.children_of(obj)
        if children is None:
            result.notes.append(f"a {role or 'node'} at depth {depth} returned no child list")
            continue
        frontier.extend((child, depth + 1) for child in children)


def probe_application(app_id: str) -> ApplicationProbe | None:
    """Measure one application. `None` when no such application is on the bus."""

    app = backend.find_application(app_id)
    if app is None:
        return None

    toolkit, toolkit_version = backend.toolkit_of(app)
    result = ApplicationProbe(
        application_id=app_id,
        name=backend._safe(app.get_name, "") or "",
        pid=backend._safe(app.get_process_id, 0) or 0,
        toolkit=toolkit,
        toolkit_version=toolkit_version,
        interfaces=backend.interfaces_of(app),
    )
    result.collection_advertised = "Collection" in result.interfaces
    if result.collection_advertised:
        result.collection_works = backend.collection_answers(app)

    windows = backend.windows_of_application(app_id)
    result.window_count = len(windows)
    for window in windows:
        actions = backend.actions_of(window)
        if len(actions) > result.frame_action_count:
            result.frame_action_count = len(actions)
            result.frame_actions = actions
        _walk(window, result)
        if result.node_limited:
            break

    if not windows:
        result.notes.append("no windows on the bus, so only the application node was measured")
    return result


def probe_all() -> list[ApplicationProbe]:
    """Every application currently on the accessibility bus, in listed order."""

    probes = []
    for app in backend.list_applications():
        measured = probe_application(app["id"])
        if measured is not None:
            probes.append(measured)
    return probes
