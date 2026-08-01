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
    """
    root, root_fp, root_ref = describe(root_obj, 0, "")
    observations: list[Observation] = [
        (root.id, root.backend, root_ref, root_fp)
    ]
    count = 1
    truncated = False

    # (backend object, built element, its fingerprint digest, depth)
    frontier: list[tuple[Any, SemanticElement, str, int]] = [
        (root_obj, root, root_fp.digest(), 0)
    ]

    while frontier:
        next_frontier: list[tuple[Any, SemanticElement, str, int]] = []
        for obj, element, digest, depth in frontier:
            if depth >= bounds.depth:
                continue
            kids = children(obj)
            for index, child_obj in enumerate(kids):
                if count >= bounds.max_nodes:
                    truncated = True
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
            if truncated:
                break
        if truncated:
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
) -> tuple[list[SemanticElement], list[Observation], bool]:
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

    return matches, observations, truncated


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
