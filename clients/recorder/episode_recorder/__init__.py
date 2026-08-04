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
"""

from .board import Board, BoardError, GitHubBoard
from .episode import Agent, Episode, Recorder, branch_name, episode_id
from .filer import Filer, Filing
from .finding import Finding, NotFileable, Occurrence
from .review import Review, Step
from .store import Author, Store, StoreError

__all__ = [
    "Agent",
    "Author",
    "Board",
    "BoardError",
    "Episode",
    "Filer",
    "Filing",
    "Finding",
    "GitHubBoard",
    "NotFileable",
    "Occurrence",
    "Recorder",
    "Review",
    "Step",
    "Store",
    "StoreError",
    "branch_name",
    "episode_id",
]
