"""The skill commons: what one agent worked out, in a shape another can be handed.

An agent that has just spelunked fifty nodes of an accessibility tree to find a
private message knows something. Right now it knows it until the session ends,
and the next agent — on this machine or any other — starts at the same fifty
nodes. Worse, an agent that failed at the task once tends to keep the belief
rather than the attempt: *I cannot read Discord*. Both are the same missing
organ. There is nowhere to put what was figured out.

This package is that place, and it is deliberately two halves.

The **write side** is what happens on the machine that derived the route. A
route becomes a `Skill` — an ordered list of protocol calls, element roles and
landmarks, and never an element id, a window title or a word off the screen. It
is refused at construction if it is shaped wrong, screened again once rendered,
and only then rendered into the pair that gets submitted: the skill for the
agent that will follow it, and a review for the person who decides whether it
should exist. That side extends what the episode recorder already does — file a
finding through a board, under a bar, at a cap — from issues to pull requests.

The **read side** is what happens on every other machine. Merged skills are
files in a directory, indexed by a registry that can list, fetch and search
them, and handed to the agent runtime as ordinary skills. They are advisory:
a route is what worked somewhere else, and an agent following one verifies each
step against the tree in front of it. A landmark that is not there is a skill to
amend, not a step to retry.

Between the two halves are the two verbs a *person* has: publish one skill, and
fetch the ones other people published. Publishing shows the rendered pair in
full before anything leaves, and sends it to the project's own service rather
than opening a pull request from here, so contributing needs no GitHub account,
no token and no git on the machine that learned the route. Fetching adds a
merged skill to the folder the runtime already reads, marks it as having come
from the commons, and can take it back out again without touching a route this
machine worked out for itself.

The rule that shapes everything here is that auto-downloading text which shapes
behaviour is a supply chain. A poisoned skill is a prompt injection with a
delivery service, so an agent *publishes a candidate* and the registry *admits*
it — never a direct push — and what admits it is a human reading two files that
were generated rather than written.
"""

from . import frontmatter
from .fetch import ORIGIN_FILE, Fetched, Fetcher, GitHubCommons, NotFetchable, Published
from .frontmatter import MalformedHeader
from .publish import HttpService, Preview, Publisher, PublishingService, Receipt
from .render import ADVISORY, describe, header, render, render_review
from .reviewer import (
    QUESTIONS,
    CommandReviewer,
    Opinion,
    Panel,
    Review,
    Reviewer,
    Unobtainable,
    ask,
)
from .skill import (
    AMENDMENTS,
    BAR,
    Amendment,
    NotPublishable,
    Skill,
    Step,
    Verification,
    as_document,
    from_document,
)
from .validator import SENSITIVE_APPLICATIONS, Screen, Verdict, scan, validate

__all__ = [
    "ADVISORY",
    "AMENDMENTS",
    "BAR",
    "ORIGIN_FILE",
    "QUESTIONS",
    "SENSITIVE_APPLICATIONS",
    "Amendment",
    "CommandReviewer",
    "Fetched",
    "Fetcher",
    "GitHubCommons",
    "HttpService",
    "MalformedHeader",
    "NotFetchable",
    "NotPublishable",
    "Opinion",
    "Panel",
    "Preview",
    "Published",
    "Publisher",
    "PublishingService",
    "Receipt",
    "Review",
    "Reviewer",
    "Screen",
    "Skill",
    "Step",
    "Unobtainable",
    "Verdict",
    "Verification",
    "as_document",
    "ask",
    "describe",
    "frontmatter",
    "from_document",
    "header",
    "render",
    "render_review",
    "scan",
    "validate",
]
