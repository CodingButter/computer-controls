"""What arrives on the wire, and everything that can be wrong with it before a gate runs.

This is the shape check, and it is deliberately the boring half. `skill.py`
already refuses a step whose method is a sentence or whose landmark is an
address; all this file does is get a payload into the shape `skill.py` can refuse,
and turn the ways that can fail into named screens instead of tracebacks.

Two decisions are worth the words.

**The field list is closed.** A payload carrying a key this service does not know
is refused, by the name of the key. That reads like pedantry until you name the
key somebody will eventually send: `token`. A service that ignored unknown fields
would receive a contributor's credential, drop it on the floor, and have had it in
memory and quite possibly in a log line on the way. Refusing by name means the
sender is told, in the one case where being told matters, that this service does
not want the thing they just sent it. It never repeats the value.

**A submission is one skill.** Not a list of one, not a list at all. One skill is
one branch is one pull request is one thing a reviewer decides about, and a
submission carrying two would either become a branch a reviewer approves two
skills from while reading one, or a silent half-publish of whichever one came
first. Both are worse than a refusal naming the rule.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from skill_commons import NotPublishable, Screen, Skill, from_document, scan

#: The keys a submission may carry, and no others. `document` and `review` are
#: the rendered pair as the contributor was shown it — not what gets published,
#: but what publishing is checked against.
FIELDS = frozenset({"skill", "document", "review", "attribution"})

#: What a contributor may be credited as, if they ask to be. A handle shape
#: rather than a free field, because a pull request body with somewhere to put a
#: sentence is a pull request body with somewhere to put a sentence somebody
#: interpolated a value into. The same ruling `finding.py` makes about issue
#: bodies and `render.py` makes about the pair.
ATTRIBUTION = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\Z")

#: How large a submission may be. Two rendered Markdown files and a JSON
#: document are a few kilobytes; this is generous by an order of magnitude and
#: still small enough that nothing can be posted here to fill a disk. Over it is
#: a refusal with a reason, never a dropped connection — a contributor whose
#: request vanished has no way to tell a limit from an outage.
MAX_BYTES = 64 * 1024


def safely(said: str, *, instead: str) -> str:
    """A message worth repeating, or a replacement for one that is not.

    `skill.py` refuses a malformed field by quoting it, deliberately and
    unsanitised, and on the machine that derived the route that is right: the
    value is on that machine already, and a refusal that will not say which
    field is a refusal nobody can act on.

    Across a wire it is a different sentence. The same words go into a response
    body, whatever sits between here and the browser, and whatever the client
    writes down — three places the value was not, reached because this service
    was being helpful. So the text is run through the screen the published pair
    goes through, and repeated only when that screen finds nothing.
    """
    return instead if scan(said) else said


class Refused(ValueError):
    """The submission was not published, and here is every screen that said so.

    Carries screens rather than a message, for the reason the curation ledger
    gives: a refusal is an outcome with a vocabulary, and a caller handed a
    sentence has to parse English to build a page out of it.
    """

    def __init__(self, *screens: Screen) -> None:
        super().__init__("; ".join(screen.reason for screen in screens))
        self.screens = tuple(screens)


@dataclass(frozen=True)
class Submitted:
    """One submission, in the shape the rest of this package works in.

    `document` and `review` are what the contributor was shown. They are held
    separately from `skill` and never written anywhere: this service renders the
    pair it publishes from `skill`, and these two exist only to be compared
    against that rendering.
    """

    skill: Skill
    document: str
    review: str
    attribution: str = ""


def read(payload: object) -> Submitted:
    """A payload, as a submission, or a `Refused` naming what was wrong with it.

    Raises rather than answering with a verdict, because there is nothing to run
    the later screens against: a payload that is not a submission has no skill to
    screen, and returning a half-built one would mean every screen downstream
    checking whether it got a real thing.
    """
    if not isinstance(payload, dict):
        raise Refused(
            Screen(
                "shape",
                False,
                "a submission is a JSON object with a `skill`, the `document`"
                " and `review` it was shown as, and nothing else required",
            )
        )

    if "skills" in payload or isinstance(payload.get("skill"), list):
        raise Refused(
            Screen(
                "one-skill",
                False,
                "a submission is one skill: one skill is one branch, one pull"
                " request and one thing a reviewer decides about, so two are"
                " sent as two submissions rather than approved as one",
            )
        )

    unknown = sorted(set(payload) - FIELDS)
    if unknown:
        raise Refused(
            Screen(
                "shape",
                False,
                "this service takes "
                + ", ".join(f"`{field}`" for field in sorted(FIELDS))
                + " and refuses everything else, including "
                + ", ".join(f"`{field}`" for field in unknown)
                + ": a field it did not expect is a field it would be holding"
                " on your behalf without having decided to",
            )
        )

    document = payload.get("document")
    review = payload.get("review")
    if not isinstance(review, str) or not review.strip():
        raise Refused(
            Screen(
                "review",
                False,
                "a skill is published as a pair and the review half is missing:"
                " the review is what the person merging this reads, and there is"
                " no flag here that publishes without one",
            )
        )
    if not isinstance(document, str) or not document.strip():
        raise Refused(
            Screen(
                "shape",
                False,
                "the `document` half of the pair is missing: send the skill"
                " exactly as it was shown to you, so that what you approved can"
                " be held against what would be published",
            )
        )

    attribution = payload.get("attribution", "")
    if not isinstance(attribution, str):
        attribution = ""
    attribution = attribution.strip().lstrip("@")
    if attribution and not ATTRIBUTION.match(attribution):
        raise Refused(
            Screen(
                "attribution",
                False,
                "being credited is an offer and the credit is a handle, up to"
                " 39 letters, digits, dots, dashes and underscores: this is a"
                " pull request body, not a place to write in",
            )
        )

    try:
        skill = from_document(payload["skill"])
    except NotPublishable as refusal:
        raise Refused(
            Screen(
                "shape",
                False,
                safely(
                    str(refusal),
                    instead="a field in this skill is not a shape the commons"
                    " publishes, and what it held was withheld here because it"
                    " looked like an address, a link, a number or a key: the"
                    " machine you sent this from screens the same fields and"
                    " will name the one that failed",
                ),
            )
        ) from None
    except (KeyError, TypeError, ValueError):
        raise Refused(
            Screen(
                "shape",
                False,
                "the `skill` is not a skill document: it carries an app, a task,"
                " a verification, an author and ordered steps, each of which is"
                " a method, an element role and a landmark",
            )
        ) from None

    return Submitted(
        skill=skill,
        document=document,
        review=review,
        attribution=attribution,
    )
