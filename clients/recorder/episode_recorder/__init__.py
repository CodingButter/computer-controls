"""Episodes as git.

A client of the desktop service, and only a client: it opens no socket, calls no
method, and imports nothing from the service. It is handed what a driving client
already received — the identity from the handshake and the action results, with
the delta engine's own account of what changed — and writes that into a git
repository. The service gained nothing to make this possible, which is the point:
recording is something you do with the answers, not a mode the desktop is put in.
"""

from .episode import Agent, Episode, Recorder, branch_name
from .review import Review, Step
from .store import Author, Store, StoreError

__all__ = [
    "Agent",
    "Author",
    "Episode",
    "Recorder",
    "Review",
    "Step",
    "Store",
    "StoreError",
    "branch_name",
]
