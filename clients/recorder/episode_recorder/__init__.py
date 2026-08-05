"""Episodes as git.

A client of the desktop service, and only a client: it opens no socket, calls no
method, and imports nothing from the service. It is handed what a driving client
already received — the identity from the handshake and the action results, with
the delta engine's own account of what changed — and writes that into a git
repository. The service gained nothing to make this possible, which is the point:
recording is something you do with the answers, not a mode the desktop is put in.

A reviewer reads those episodes back, and when the same conclusion arrives twice
it can file it on the board itself, under a recurrence bar and a cap on how many
issues it may have open at once. That last step is off unless it is switched on.

The same bar turns a route through an application into a skill. An agent that
works out where something lives writes the route down; a second agent that
derives the same route agrees it, and what the two agree on becomes a procedure
the next session starts from instead of re-deriving. When the application moves
and the route stops answering, the skill is marked as no longer standing and
amended the same way it was learned — twice, agreed, with the change recorded.
"""

from .board import Board, BoardError, GitHubBoard
from .episode import Agent, Episode, Recorder, branch_name, episode_id
from .filer import Filer, Filing
from .finding import Finding, NotFileable, Occurrence
from .review import Review, Step
from .skill import (
    Anchor,
    Derivation,
    NotDurable,
    Outcome,
    Skill,
    SkillLibrary,
    Stumble,
    Waypoint,
)
from .store import Author, Store, StoreError

__all__ = [
    "Agent",
    "Anchor",
    "Author",
    "Board",
    "BoardError",
    "Derivation",
    "Episode",
    "Filer",
    "Filing",
    "Finding",
    "GitHubBoard",
    "NotDurable",
    "NotFileable",
    "Occurrence",
    "Outcome",
    "Recorder",
    "Review",
    "Skill",
    "SkillLibrary",
    "Step",
    "Store",
    "StoreError",
    "Stumble",
    "Waypoint",
    "branch_name",
    "episode_id",
]
