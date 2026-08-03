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
from time import monotonic
from typing import Any, Callable

from .model import SemanticElement
from .registry import Fingerprint

# (element_id, backend, backend_reference, fingerprint) — what the registry records.
Observation = tuple[str, str, dict[str, Any], Fingerprint]

DEFAULT_DEPTH = 3
DEFAULT_MAX_NODES = 200

#: Mirrors atspi.MAX_ANCESTOR_WALK — a broken toolkit can hand back a parent
#: chain that never terminates, and the walk must stop before the loop thread
#: does.
MAX_ANCESTORS = 32
MAX_DESCENDANTS = 10
DEFAULT_MAX_EXPAND_NODES = 2000
DEFAULT_MAX_SIBLINGS_PER_HIT = 10


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
    #: Expansion was cut short by the node budget or time limit, not the search.
    #: Distinct from `truncated`: the search covered the window, but some
    #: matches did not get their full neighbourhood.
    neighbourhood_truncated: bool = False


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

# Returns a backend object's parent, or None at the root.
ParentOf = Callable[[Any], Any | None]


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
    parent_of: ParentOf | None = None,
    role: str | None = None,
    name: str | None = None,
    states: frozenset[str] = frozenset(),
    limit: int = 50,
    max_nodes: int = 2000,
    ancestors: int = 0,
    descendants: int = 0,
    siblings: bool = False,
    max_expand_nodes: int = DEFAULT_MAX_EXPAND_NODES,
    max_siblings_per_hit: int = DEFAULT_MAX_SIBLINGS_PER_HIT,
    deadline: float | None = None,
) -> "QueryResult":
    """Find matching elements without building a tree.

    Returns a flat list, because a query's answer is "these elements", not "here
    is the shape of the window". `max_nodes` bounds the search itself so a query
    against a pathological tree terminates; `limit` bounds the answer.

    When ``ancestors``, ``descendants`` or ``siblings`` is set, each match is
    expanded *after* the match set is capped by ``limit``: the ancestor chain is
    walked up, the descendant subtree walked down, and immediate siblings
    listed. Expansion shares a node budget (``max_expand_nodes``) and an
    optional wall-clock ``deadline``; hitting either sets
    ``neighbourhood_truncated`` so the caller knows the neighbourhood is
    partial, not the search. Expansion runs after ``limit`` caps the match set,
    so the bound is ``limit × neighbourhood``, not application size.
    """
    matches: list[SemanticElement] = []
    match_objs: list[Any] = []
    match_digests: list[str] = []
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
        digest = fingerprint.digest()
        if _matches(element, role, needle, states):
            matches.append(element)
            match_objs.append(obj)
            match_digests.append(digest)
        for child_index, child in enumerate(children(obj)):
            frontier.append((child, child_index, digest))

    more = truncated or (len(matches) >= limit and bool(frontier))
    neighbourhood_truncated = _expand_neighbourhood(
        matches, match_objs, match_digests, observations,
        describe=describe, children=children, parent_of=parent_of,
        ancestors=ancestors, descendants=descendants, siblings=siblings,
        max_expand_nodes=max_expand_nodes,
        max_siblings_per_hit=max_siblings_per_hit,
        deadline=deadline,
    )
    return QueryResult(
        matches=matches, observations=observations,
        truncated=truncated, more=more,
        neighbourhood_truncated=neighbourhood_truncated,
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


def _sibling_index(obj: Any, parent_of: ParentOf, children: Children) -> int:
    """The position of *obj* among its parent's children, or 0 at the root."""
    parent = parent_of(obj)
    if parent is None:
        return 0
    for i, child in enumerate(children(parent)):
        if child is obj:
            return i
    return 0


def _expand_neighbourhood(
    matches: list[SemanticElement],
    match_objs: list[Any],
    match_digests: list[str],
    observations: list[Observation],
    *,
    describe: Describe,
    children: Children,
    parent_of: ParentOf | None,
    ancestors: int,
    descendants: int,
    siblings: bool,
    max_expand_nodes: int,
    max_siblings_per_hit: int,
    deadline: float | None,
) -> bool:
    """Expand ancestors, descendants and siblings around each match.

    Runs *after* the match set is capped by ``limit``, so the cost scales with
    the answer size, not the application size. Returns ``True`` when the node
    budget or deadline was hit before every match was fully expanded.
    """
    if not matches or (ancestors == 0 and descendants == 0 and not siblings):
        return False

    expanded = 0
    neighbourhood_truncated = False

    def can_expand() -> bool:
        nonlocal neighbourhood_truncated
        if expanded >= max_expand_nodes or (
            deadline is not None and monotonic() >= deadline
        ):
            neighbourhood_truncated = True
            return False
        return True

    for match, match_obj, match_digest in zip(matches, match_objs, match_digests):
        # --- Ancestors ---
        if ancestors > 0 and parent_of is not None:
            chain: list[Any] = []
            node = match_obj
            for _ in range(ancestors):
                parent = parent_of(node)
                if parent is None:
                    break
                chain.append(parent)
                node = parent
            # Describe root-ward so each ancestor's parent_digest threads from
            # the one above it. The topmost ancestor gets "" — its own parent
            # is outside the chain, and the atspi backend re-derives the digest
            # from the object itself regardless (atspi.py:528-531).
            described: list[tuple[SemanticElement, Fingerprint]] = []
            prev_digest = ""
            for obj in reversed(chain):
                if not can_expand():
                    break
                idx = _sibling_index(obj, parent_of, children)
                elem, fp, ref = describe(obj, idx, prev_digest)
                expanded += 1
                observations.append((elem.id, elem.backend, ref, fp))
                described.append((elem, fp))
                prev_digest = fp.digest()
            match.ancestry = [e for e, _ in reversed(described)]

        if neighbourhood_truncated:
            break

        # --- Descendants ---
        if descendants > 0:
            dfrontier: list[tuple[Any, SemanticElement, str, int]] = [
                (match_obj, match, match_digest, 0)
            ]
            while dfrontier:
                obj, parent_elem, parent_dig, depth = dfrontier.pop(0)
                if depth >= descendants:
                    continue
                for index, child_obj in enumerate(children(obj)):
                    if not can_expand():
                        break
                    child_elem, child_fp, child_ref = describe(
                        child_obj, index, parent_dig
                    )
                    expanded += 1
                    observations.append(
                        (child_elem.id, child_elem.backend, child_ref, child_fp)
                    )
                    parent_elem.children.append(child_elem)
                    dfrontier.append(
                        (child_obj, child_elem, child_fp.digest(), depth + 1)
                    )
                if neighbourhood_truncated:
                    break

        if neighbourhood_truncated:
            break

        # --- Siblings ---
        if siblings and parent_of is not None:
            parent_obj = parent_of(match_obj)
            if parent_obj is not None:
                # Describe the parent once to obtain the digest every sibling
                # shares. The atspi backend re-derives identity from the object,
                # so this produces the same id whether or not the parent was
                # visited during the search.
                if not can_expand():
                    break
                p_idx = _sibling_index(parent_obj, parent_of, children)
                _p_elem, p_fp, p_ref = describe(parent_obj, p_idx, "")
                expanded += 1
                observations.append(
                    (_p_elem.id, _p_elem.backend, p_ref, p_fp)
                )
                p_digest = p_fp.digest()

                sib_count = 0
                for index, sib_obj in enumerate(children(parent_obj)):
                    if sib_obj is match_obj:
                        continue
                    if sib_count >= max_siblings_per_hit:
                        break
                    if not can_expand():
                        break
                    sib_elem, sib_fp, sib_ref = describe(sib_obj, index, p_digest)
                    expanded += 1
                    observations.append(
                        (sib_elem.id, sib_elem.backend, sib_ref, sib_fp)
                    )
                    match.siblings.append(sib_elem)
                    sib_count += 1

        if neighbourhood_truncated:
            break

    return neighbourhood_truncated
