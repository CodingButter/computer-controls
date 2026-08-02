"""Bounded inspection and filtered queries.

Every function here returns a *bounded* result. That is the whole point of the
project: an unbounded accessibility tree dumped into a model's context is the
failure mode this exists to avoid, so there is no code path that returns "all of
it". A request that would exceed its node budget comes back marked `truncated`
rather than silently partial — a caller that cannot tell the difference between
"no children" and "I stopped counting" will make bad decisions with total
confidence.

Results are paired with *observations* for the registry: inspection is how the
caller is told what exists, so it is also the moment the registry records what
the caller now believes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .model import SemanticElement
from .registry import Fingerprint

# (element_id, backend, backend_reference, fingerprint) — what the registry records.
Observation = tuple[str, str, dict[str, Any], Fingerprint]

DEFAULT_DEPTH = 3
DEFAULT_MAX_NODES = 200


@dataclass
class InspectionResult:
    root: SemanticElement
    observations: list[Observation]
    node_count: int
    truncated: bool


@dataclass
class QueryResult:
    matches: list[SemanticElement]
    observations: list[Observation]
    #: The search itself gave up before covering the window.
    truncated: bool
    #: There are more matches to be had — either because the search was cut
    #: short or because the answer hit its limit with tree still unwalked.
    more: bool


@dataclass
class Bounds:
    """The limits on a single inspection.

    `max_nodes` is a hard budget across the whole walk, not a per-level limit —
    a tree that is shallow and enormously wide is exactly as expensive as a deep
    one, and only a global budget catches both.
    """

    depth: int = DEFAULT_DEPTH
    max_nodes: int = DEFAULT_MAX_NODES
    include_roles: frozenset[str] | None = None
    exclude_roles: frozenset[str] = frozenset()

    def wants(self, role: str) -> bool:
        if role in self.exclude_roles:
            return False
        if self.include_roles is not None and role not in self.include_roles:
            return False
        return True


# Turns a backend object into (element, fingerprint, reference) given its index
# among siblings and its parent's fingerprint digest.
Describe = Callable[[Any, int, str], tuple[SemanticElement, Fingerprint, dict[str, Any]]]

# Yields a backend object's children.
Children = Callable[[Any], list[Any]]


def inspect_tree(
    root_obj: Any,
    *,
    describe: Describe,
    children: Children,
    bounds: Bounds,
) -> InspectionResult:
    """Walk breadth-first within the bounds and build a compact tree.

    Breadth-first rather than depth-first on purpose: when the budget runs out,
    what survives is a shallow view of the whole window rather than one deep
    tunnel down its first branch. A caller who gets cut off should still know
    roughly what the window contains.

    Both ways of running out say so. The node budget is global, so exhausting it
    ends the walk; the depth limit is per branch, so a branch that bottoms out on
    it says nothing about its siblings and the walk continues. They are reported
    the same way because they mean the same thing to a caller — there is more
    down there than you were shown — and the alternative is a tree cut off at
    depth twelve that is indistinguishable from a tree that ended at depth
    twelve. Measured against a live Discord, that silence hides 97% of the
    application.
    """
    root, root_fp, root_ref = describe(root_obj, 0, "")
    observations: list[Observation] = [
        (root.id, root.backend, root_ref, root_fp)
    ]
    count = 1
    truncated = False
    #: The node budget is spent and no further branch can be walked. Distinct
    #: from `truncated`, which only records that the caller was shown less than
    #: there is: a depth-limited branch sets that without ending the walk.
    #:
    #: Today the two could be one flag, because this walk is breadth-first and
    #: every node in a level shares a depth, so the level that reaches the
    #: ceiling is the last level either way. That is an invariant of the
    #: traversal, not of the bounds, and it is not worth being one edit away
    #: from a walk that stops early and calls it a complete answer.
    exhausted = False

    # (backend object, built element, its fingerprint digest, depth)
    frontier: list[tuple[Any, SemanticElement, str, int]] = [
        (root_obj, root, root_fp.digest(), 0)
    ]

    while frontier:
        next_frontier: list[tuple[Any, SemanticElement, str, int]] = []
        for obj, element, digest, depth in frontier:
            if depth >= bounds.depth:
                # Costs one child lookup per boundary node and no `describe`,
                # which is where a walk's expense actually lives. Asking is the
                # only way to tell a branch that ended from one that was cut:
                # a node's own child count is the difference between "this
                # window contains 29 things" and "you were shown 29 of 952".
                if children(obj):
                    truncated = True
                    element.truncated = True
                continue
            kids = children(obj)
            for index, child_obj in enumerate(kids):
                if count >= bounds.max_nodes:
                    truncated = True
                    exhausted = True
                    element.truncated = True
                    break
                child, child_fp, child_ref = describe(child_obj, index, digest)
                count += 1
                observations.append(
                    (child.id, child.backend, child_ref, child_fp)
                )
                # A role filter shapes what comes back, never where we walk. On
                # GTK4 every interesting control sits under several unnamed
                # panels, so pruning the traversal by role would make a query
                # for buttons return nothing at all. Filtered-out nodes are
                # still traversed; they just do not appear in the result.
                if bounds.wants(child.role):
                    element.children.append(child)
                    next_frontier.append(
                        (child_obj, child, child_fp.digest(), depth + 1)
                    )
                else:
                    next_frontier.append(
                        (child_obj, element, child_fp.digest(), depth + 1)
                    )
            if exhausted:
                break
        if exhausted:
            break
        frontier = next_frontier

    return InspectionResult(
        root=root, observations=observations, node_count=count, truncated=truncated
    )


def query(
    root_obj: Any,
    *,
    describe: Describe,
    children: Children,
    role: str | None = None,
    name: str | None = None,
    states: frozenset[str] = frozenset(),
    limit: int = 50,
    max_nodes: int = 2000,
) -> "QueryResult":
    """Find matching elements without building a tree.

    Returns a flat list, because a query's answer is "these elements", not "here
    is the shape of the window". `max_nodes` bounds the search itself so a query
    against a pathological tree terminates; `limit` bounds the answer.
    """
    matches: list[SemanticElement] = []
    observations: list[Observation] = []
    searched = 0
    truncated = False
    needle = name.casefold() if name else None
    # Two different endings that look identical from the outside: the walk gave
    # up (truncated) or the answer filled up (limit reached). A caller deciding
    # whether to narrow its filter needs to know which one it got.

    frontier: list[tuple[Any, int, str]] = [(root_obj, 0, "")]
    while frontier and len(matches) < limit:
        obj, index, parent_digest = frontier.pop(0)
        if searched >= max_nodes:
            truncated = True
            break
        element, fingerprint, reference = describe(obj, index, parent_digest)
        searched += 1
        observations.append(
            (element.id, element.backend, reference, fingerprint)
        )
        if _matches(element, role, needle, states):
            matches.append(element)
        digest = fingerprint.digest()
        for child_index, child in enumerate(children(obj)):
            frontier.append((child, child_index, digest))

    more = truncated or (len(matches) >= limit and bool(frontier))
    return QueryResult(
        matches=matches, observations=observations, truncated=truncated, more=more
    )


def _matches(
    element: SemanticElement,
    role: str | None,
    needle: str | None,
    states: frozenset[str],
) -> bool:
    if role is not None and element.role != role:
        return False
    if needle is not None and needle not in element.name.casefold():
        return False
    if states and not states.issubset(set(element.states)):
        return False
    return True
