"""A reviewer's conclusion, in a shape that cannot carry a secret.

An issue is the one artifact in this system that leaves the machine. An episode
stays on the disk it was recorded on; a ticket is on somebody else's server the
moment it is filed, and it is on that server forever. So the rule that governs
what may be written here is stricter than the one governing the episode itself,
and it is enforced the same way the delta engine enforces its own: by allowlist,
so that a field nobody thought about is absent rather than copied.

The decision that does most of the work is that **a finding carries no prose**.
There is no field a reviewing agent can write a sentence into. The title and the
body of a filed issue are generated here, from enumerated fields, by a template
in this file — because a filer that can be handed a sentence is a filer that can
be handed a password, and no amount of scanning the sentence afterwards fixes
that. What a reviewer supplies is which kind of finding it is, which step of
which episodes it happened on, and a handful of structural words; what it cannot
supply is anything it read on the screen.

The structural words are constrained by shape rather than by a vocabulary this
file would have to keep in step with the protocol. A method name is a camelCase
identifier, an error code is a shouted constant, an element role is lower-case
words. `recorder_tests/test_findings_are_filed.py` holds those shapes against
the protocol's real method and error vocabularies, so a shape that stopped
admitting the actual protocol would fail there rather than quietly here. What
the shapes buy is the property that matters: none of them admits a sentence, a
newline, or a secret, and `hunter2-correct-horse` is not a role.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, replace
from typing import Any

from .store import Author

#: What a finding may be about. The four the ruling names, and no fifth: a kind
#: nobody enumerated is a kind whose issue body nobody wrote.
KINDS: dict[str, str] = {
    "recurring-failure": "the same wrong turn, taken again",
    "missing-tool": "something absent, worked around again",
    "behaviour-change": "a change to how a named agent should act",
    "skill": "the same sequence, performed successfully again",
}

#: How much a kind is worth when the board is full and something has to give.
#: A failure that keeps happening outranks a convenience, because the board's
#: scarce resource is attention and a repeated failure is what attention is for.
KIND_WEIGHT: dict[str, int] = {
    "recurring-failure": 3,
    "behaviour-change": 2,
    "missing-tool": 2,
    "skill": 1,
}

#: Which part of the repository a finding lands in. These are the labels this
#: board already uses; the filer invents none, because a label that has to be
#: created is a permission the filer should not need.
AREAS = ("area:client", "area:plugin", "area:protocol", "area:service")

#: A method is an identifier in the protocol, and identifiers do not contain
#: spaces, punctuation or newlines.
METHOD = re.compile(r"\A[a-z][A-Za-z0-9]{0,39}\Z")

#: An error code is shouted, which is a shape a sentence cannot take.
ERROR = re.compile(r"\A[A-Z][A-Z0-9_]{0,39}\Z")

#: A role is what the accessibility layer calls a thing — `push button`,
#: `password text`. Lower-case words only: no digits, so nothing that looks like
#: a value fits, and no newline, so nothing that looks like a paragraph does.
ROLE = re.compile(r"\A[a-z][a-z ]{0,39}\Z")

#: A tool is named the way a tool is named. Same shape as a method, plus the
#: underscores agent tooling tends to use.
TOOL = re.compile(r"\A[a-z][A-Za-z0-9_]{0,39}\Z")

#: An element id is an opaque handle the service issued. It is not content — it
#: is the name of a place content was — but it is still held to a shape, because
#: "it will only ever be a handle" is an assumption and this is the file that
#: does not make assumptions.
HANDLE = re.compile(r"\A[A-Za-z0-9_.:-]{1,64}\Z")


class NotFileable(ValueError):
    """A finding refused before it could become a ticket.

    Raised rather than sanitised. A filer that quietly dropped a field it did
    not like would file an issue that was missing the thing the reviewer thought
    it was reporting, and nobody would be told.
    """


@dataclass(frozen=True)
class Occurrence:
    """One time this happened, named by commit rather than by name.

    An episode's branch name is its intent, written in the words of whoever
    decided to act — `sell-the-ps5`, `message-alice-about-the-price`. That is
    the agent's own sentence rather than something read off the screen, but it
    is still a sentence, and this file does not put sentences on a server. A
    commit hash names the same episode exactly, means nothing to anybody without
    the store, and means everything to anybody with it.
    """

    episode: str
    step: int
    commit: str

    def __post_init__(self) -> None:
        for value in (self.episode, self.commit):
            if not re.fullmatch(r"[0-9a-f]{7,40}", value):
                raise NotFileable(f"not a commit hash: {value!r}")
        if self.step < 1:
            raise NotFileable(f"not a step number: {self.step}")


@dataclass(frozen=True)
class Finding:
    """What a reviewer concluded, reduced to what may leave the machine."""

    kind: str
    agent: Author
    occurrences: tuple[Occurrence, ...] = ()
    method: str = ""
    target: str = ""
    error: str = ""
    role: str = ""
    tool: str = ""
    area: str = "area:client"
    needs_desktop: bool = False

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise NotFileable(f"not a kind of finding: {self.kind!r}")
        if self.area not in AREAS:
            raise NotFileable(f"not an area this board routes to: {self.area!r}")
        _shaped("method", self.method, METHOD)
        _shaped("error", self.error, ERROR)
        _shaped("role", self.role, ROLE)
        _shaped("tool", self.tool, TOOL)
        _shaped("target", self.target, HANDLE)
        _shaped("agent label", self.agent.label, HANDLE)
        _shaped("agent id", self.agent.client_id, HANDLE)

    # -- identity -------------------------------------------------------

    @property
    def signature(self) -> str:
        """What makes two occurrences the same finding rather than two findings.

        Deliberately not the element the action was aimed at. An element id is a
        handle issued for one session, so the same wrong turn taken tomorrow
        names a different element, and a signature that included it would score
        every recurrence as a first occurrence — a recurrence bar that never
        fires, which is the same as no bar at all and much harder to notice.
        """
        parts = (self.kind, self.agent.client_id, self.method, self.error,
                 self.role, self.tool)
        return hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:16]

    @property
    def episodes(self) -> tuple[str, ...]:
        """The distinct episodes this was seen in, oldest first."""
        seen: list[str] = []
        for occurrence in self.occurrences:
            if occurrence.episode not in seen:
                seen.append(occurrence.episode)
        return tuple(seen)

    @property
    def rank(self) -> tuple[int, int]:
        """How strongly this asks for attention, against other findings.

        Kind first, then how often it has been seen: a pattern observed four
        times is a better claim on somebody's afternoon than the same kind of
        pattern observed twice.
        """
        return (KIND_WEIGHT[self.kind], len(self.episodes))

    def with_occurrence(self, occurrence: Occurrence) -> "Finding":
        if any(
            existing.commit == occurrence.commit and existing.step == occurrence.step
            for existing in self.occurrences
        ):
            return self
        return replace(self, occurrences=self.occurrences + (occurrence,))

    # -- routing --------------------------------------------------------

    def labels(self) -> tuple[str, ...]:
        """The labels this board already uses, and only those.

        A recurring failure is a bug; a tool that is not there and a skill worth
        having are enhancements; a change to how an agent should behave is an
        amendment to its instructions, which is the word this board uses for a
        ruling that revises an earlier one.
        """
        kind_label = {
            "recurring-failure": "bug",
            "missing-tool": "enhancement",
            "skill": "enhancement",
            "behaviour-change": "amendment",
        }[self.kind]
        lane = "needs:desktop" if self.needs_desktop else "sandbox-safe"
        return (kind_label, lane, self.area)

    # -- what gets filed ------------------------------------------------

    def title(self) -> str:
        subject = self.method or self.tool or "its instructions"
        seen = len(self.episodes)
        headline = {
            "recurring-failure": f"{subject} went wrong the same way in {seen} episodes",
            "missing-tool": f"{subject} was worked around in {seen} episodes",
            "skill": f"{subject} was performed the same way in {seen} episodes",
            "behaviour-change": f"{subject} needs revising after {seen} episodes",
        }[self.kind]
        return f"{self.agent.name}: {headline}"

    def body(self, *, filed_by: str) -> str:
        """The whole of what a worker arriving cold will ever know about this.

        `filed_by` is the reviewing agent, which is not the agent the issue is
        about. It goes in as a trailer because the cap is per filer and the
        board has to be askable which open issues are whose: everything filed
        through one machine account has the same author, so the author line
        cannot answer that question and a trailer can.

        Written as a template rather than assembled from anything the reviewer
        said, and written to be actionable without the store: the reader is told
        what the shape of the problem is, which agent it belongs to, and what
        would count as it being fixed. The commit hashes are for whoever does
        have the store, and they are marked as such rather than left looking
        like something the reader failed to understand.
        """
        lines = [
            f"Filed automatically by a reviewing agent. {KINDS[self.kind]}.",
            "",
            "## What recurred",
            "",
            self._what(),
            "",
            "## The occurrences",
            "",
            "An episode is named by an opaque id rather than by what it was"
            " called, because what it was called is a sentence and a sentence is"
            " the one thing that must not leave the machine. These name records"
            " in the episode store on the machine that did the work, not"
            " anything in this repository: whoever has that store can find one"
            " with `git log --all --grep='Episode-Id: <id>'`.",
            "",
            "| episode | step | commit |",
            "| --- | --- | --- |",
        ]
        for occurrence in self.occurrences:
            lines.append(
                f"| `{occurrence.episode}` | {occurrence.step} "
                f"| `{occurrence.commit[:12]}` |"
            )
        lines += [
            "",
            "## Filed against",
            "",
            f"The agent that calls itself `{self.agent.name}`, "
            f"connection `{self.agent.client_id}`. Its instructions, prompt,"
            " tools and model are committed at the head of each episode branch"
            " listed above, which is where a change to its behaviour would go.",
            "",
            "## What would close this",
            "",
            self._done(),
            "",
            "## What is not here, and why",
            "",
            "No field contents, no window titles, no names, nothing read out of"
            " any application. This issue was generated from a fixed set of"
            " structural fields — kind, method, element role, element handle,"
            " error code, tool name, step numbers and commit hashes — and there"
            " is no field on a finding that a sentence fits in. If the shape of"
            " the problem is not clear from the above, the episodes hold the"
            " rest, and they hold it on the machine that recorded them.",
            "",
            f"filed-by {filed_by}",
            f"filed-against {self.agent.client_id}",
            f"finding {self.signature}",
        ]
        return "\n".join(lines) + "\n"

    def _what(self) -> str:
        where = f" on an element the service called `{self.role}`" if self.role else ""
        at = f" (`{self.target}` in the most recent episode)" if self.target else ""
        failed = f", failing with `{self.error}`" if self.error else ""
        seen = len(self.episodes)
        if self.kind == "recurring-failure":
            return (
                f"`{self.method or 'an action'}`{where}{at} went the same wrong"
                f" way in {seen} distinct episodes{failed}. Once is an incident;"
                " this is the second time, which is why it is a ticket."
            )
        if self.kind == "missing-tool":
            return (
                f"The agent reached for `{self.tool}` and it was not there, in"
                f" {seen} distinct episodes, and worked around it each time"
                f"{where}{failed}."
            )
        if self.kind == "skill":
            return (
                f"The same sequence — `{self.method or self.tool}`{where} —"
                f" was performed successfully in {seen} distinct episodes. A"
                " sequence repeated is a skill nobody has written down yet."
            )
        return (
            f"How this agent behaves around `{self.method or self.tool}`{where}"
            f"{failed} was judged wrong by a reviewer in {seen} distinct"
            " episodes."
        )

    def _done(self) -> str:
        if self.kind == "recurring-failure":
            return (
                "The same call, on the same kind of element, stops going that"
                " way — or the agent is told how to avoid it and the change to"
                " its instructions is merged."
            )
        if self.kind == "missing-tool":
            return (
                f"`{self.tool}` exists and the agent is given it, or the issue"
                " is closed with the reason it should not."
            )
        if self.kind == "skill":
            return (
                "The sequence is written down as a skill the agent can be"
                " handed, rather than rediscovered."
            )
        return (
            "A diff against this agent's `agent/instructions.md`, reviewed and"
            " merged the way every other change here arrives."
        )


def _shaped(what: str, value: str, pattern: re.Pattern[str]) -> None:
    if value and not pattern.fullmatch(value):
        raise NotFileable(
            f"not a {what} this filer will put on a server: {value!r}. "
            "A finding carries structure, never anything read off the screen."
        )


def as_document(finding: Finding) -> dict[str, Any]:
    """The finding as it is written into the ledger."""
    return {
        "signature": finding.signature,
        "kind": finding.kind,
        "agent": {"clientId": finding.agent.client_id, "label": finding.agent.label},
        "method": finding.method,
        "target": finding.target,
        "error": finding.error,
        "role": finding.role,
        "tool": finding.tool,
        "area": finding.area,
        "needsDesktop": finding.needs_desktop,
        "occurrences": [
            {"episode": o.episode, "step": o.step, "commit": o.commit}
            for o in finding.occurrences
        ],
    }


def from_document(document: dict[str, Any]) -> Finding:
    return Finding(
        kind=document["kind"],
        agent=Author(
            client_id=document["agent"]["clientId"], label=document["agent"]["label"]
        ),
        occurrences=tuple(
            Occurrence(episode=o["episode"], step=o["step"], commit=o["commit"])
            for o in document.get("occurrences", [])
        ),
        method=document.get("method", ""),
        target=document.get("target", ""),
        error=document.get("error", ""),
        role=document.get("role", ""),
        tool=document.get("tool", ""),
        area=document.get("area", "area:client"),
        needs_desktop=document.get("needsDesktop", False),
    )
