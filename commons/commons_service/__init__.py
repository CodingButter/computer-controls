"""The service that holds the credential and opens the pull request.

Everything in `skill_commons` runs on the machine that derived the route, and one
step of it does not belong there. `Curator.submit` screens a skill and then hands
it to a `GitHubForge`, which drives `git` and `gh` with whatever token that
machine has installed. That is the seam this package cuts.

The consequence of leaving it uncut is not a technical one. It is that publishing
a skill requires a GitHub account, a token, a checkout and a working `gh` — and
the collective this commons is for is not a collective of git users. Somebody who
worked out how to read a private message in Discord has something worth
publishing whether or not they have ever opened a terminal.

So the credential moves. One account posts every proposal, it lives on a server,
and a contributor sends a submission and receives a pull request number. What
they never send is a credential: there is no field for one here, and a payload
that carries one is refused by the name of the field rather than accepted and
forgotten.

Three rules, and the first is why this package exists rather than a route on some
other server.

**The gate runs here too.** `skill_commons.validate` runs on the contributor's
machine before anything is shown to them, and it will keep running there, because
a refusal that arrives before a submission is a better refusal. But a screen that
only ever runs on the sender's machine is a screen a modified sender skips. So
every screen runs again on arrival, against the text this service is about to
publish, and the local run is treated as a courtesy rather than as evidence.

**The bytes reviewed are the bytes published, and the bytes shown are both.**
Nothing a contributor typed reaches the repository. The submission carries the
skill as enumerated fields, this service renders the pair itself, and it publishes
what it rendered. What the contributor sends *alongside* that is the pair they
were shown, and it has to match this service's rendering byte for byte or the
submission is refused — because a client whose renderer has drifted, or been
edited, is a client showing somebody one thing and sending another.

**A refusal is legible or it is a bug report.** Every no answers with the screens
that ran, each named, each with a sentence a contributor's page can render. A
server that failed silently would leave somebody who did nothing wrong believing
the feature is broken, and the one thing worse for a commons than a bad
submission is a good one nobody sent twice.

What this service must never do is reach a machine. It imports nothing from
`desktop_service`, it has no verb that touches a desktop, and the only address it
knows is a repository's. `commons_service_tests/test_nothing_here_reaches_a_desktop.py`
holds it to that.
"""

from .publishing import Publisher, TOKEN_ENV, publish_disabled
from .submission import (
    ATTRIBUTION,
    FIELDS,
    MAX_BYTES,
    Refused,
    Submitted,
    read,
)

__all__ = [
    "ATTRIBUTION",
    "FIELDS",
    "MAX_BYTES",
    "Publisher",
    "Refused",
    "Submitted",
    "TOKEN_ENV",
    "publish_disabled",
    "read",
]
