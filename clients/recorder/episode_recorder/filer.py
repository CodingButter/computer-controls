"""Filing a finding, under a recurrence bar and a hard cap on open issues.

Two rules stand between a reviewing agent and the board, and they are doing
different jobs.

**The bar filters noise.** An agent that files a lesson learned after every task
produces a hundred tickets a day, and a board nobody can read is a board nobody
reads. So nothing is filed on first occurrence. Once is an incident; twice
across distinct episodes is a pattern, and a pattern is the only thing worth
somebody's afternoon. The first occurrence is not discarded — it is written into
the ledger, which is the whole reason the second one can be recognised — it
simply does not become a ticket.

**The cap forces ranking.** A filer has a fixed number of open issues and cannot
exceed it. At the cap it has exactly two moves: stay quiet, or withdraw one of
its own weakest open issues and say why. That is triage happening at the source,
where the context still is, rather than on a board where somebody else has to
reconstruct it. The withdrawal is written into the ledger next to the thing that
displaced it, because an agent that can quietly retract its own claims is an
agent whose record is a summary rather than a history.

The ledger lives on a branch of the episode store, for the same reason the
episodes do: it is read by `git log` on somebody else's machine, it cannot be
edited without leaving a commit saying so, and it needs no database. It carries
no timestamps of its own. Git commits are already dated, and a record that dated
itself would be a second answer to the same question — so where the ledger needs
to know which of two filings is older, it asks the issue numbers, which the
board hands out in order.

Off by default. `DESKTOP_AGENT_FILING` selects it, read once, read as set or not
set, exactly as `DESKTOP_HUMAN_PRESENT` is — somebody who typed the variable has
said what they meant. Switched off, the filer still observes: occurrences are
recorded and the issue that *would* have been filed is rendered and returned, so
that the question of whether the bar holds can be answered by watching it rather
than by argument. That is the condition the ruling put on turning it on.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace

from .board import Board
from .finding import Finding, as_document, from_document
from .store import Author, Store

#: The one way to say that filing is wanted here. Not a constructor default,
#: because the default is off and a default that lives in a keyword argument is
#: a default somebody flips by accident.
FILING_ENV = "DESKTOP_AGENT_FILING"

#: The branch the ledger lives on. Not an episode, and deliberately not named
#: like one.
LEDGER = "findings"

#: How many issues one filer may have open at once. Small on purpose: a cap that
#: is never reached is not a cap, it is a comment.
CAP = 5

#: How many distinct episodes a finding needs before it is a pattern.
BAR = 2


@dataclass(frozen=True)
class Filing:
    """What the filer did about a finding, and why.

    Always answers with the issue it would file, filed or not. The refusals are
    the interesting cases — under the bar, at the cap, switched off — and a
    refusal that did not show its work would be indistinguishable from a filer
    that was broken.
    """

    finding: Finding
    title: str
    body: str
    labels: tuple[str, ...]
    reason: str
    number: int | None = None
    withdrew: int | None = None

    @property
    def filed(self) -> bool:
        return self.number is not None


class Filer:
    """One reviewing agent's relationship with the board.

    `reviewer` is the identity doing the filing, not the identity being filed
    about. The cap belongs to it, the ledger commits are authored by it, and the
    `filed-by` trailer on every issue names it — so two reviewers working on one
    repository do not spend each other's allowance, and neither can withdraw the
    other's issues.
    """

    def __init__(
        self,
        path,
        board: Board,
        reviewer: Author,
        *,
        cap: int = CAP,
        enabled: bool | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self.store = Store(path)
        self.board = board
        self.reviewer = reviewer
        self.cap = cap
        self.enabled = (
            enabled
            if enabled is not None
            else bool((environ if environ is not None else os.environ).get(FILING_ENV, ""))
        )

    # -- the decision ---------------------------------------------------

    def observe(self, finding: Finding) -> Filing:
        """Record what a reviewer concluded, and file it if it has earned it."""
        known = self._recall(finding.signature)
        seen = finding
        if known is not None:
            for occurrence in known.occurrences:
                seen = seen.with_occurrence(occurrence)
            seen = replace(seen, occurrences=tuple(sorted(seen.occurrences, key=_order)))

        title, body, labels = self._render(seen)
        entry = self._entry(seen.signature)

        if len(seen.episodes) < BAR:
            return self._record(
                seen,
                entry,
                Filing(
                    finding=seen,
                    title=title,
                    body=body,
                    labels=labels,
                    reason=(
                        f"seen in {len(seen.episodes)} episode: once is an incident."
                        " Recorded, not filed."
                    ),
                ),
            )

        standing = entry.get("filed")
        if standing and not standing.get("withdrawn"):
            return self._record(
                seen,
                entry,
                Filing(
                    finding=seen,
                    title=title,
                    body=body,
                    labels=labels,
                    number=standing["number"],
                    reason=f"already filed as #{standing['number']}; occurrence added",
                ),
            )

        if not self.enabled:
            return self._record(
                seen,
                entry,
                Filing(
                    finding=seen,
                    title=title,
                    body=body,
                    labels=labels,
                    reason=(
                        "over the bar, and filing is off:"
                        f" set {FILING_ENV} on the invocation to turn it on."
                        " Recorded, so the bar can be watched before it is trusted."
                    ),
                ),
            )

        return self._file(seen, entry, title, body, labels)

    def _file(self, seen, entry, title, body, labels) -> Filing:
        open_now = self.board.open_issues()
        withdrew: int | None = None

        if len(open_now) >= self.cap:
            weakest = self._weakest(open_now)
            if weakest is None or seen.rank <= weakest[1].rank:
                return self._record(
                    seen,
                    entry,
                    Filing(
                        finding=seen,
                        title=title,
                        body=body,
                        labels=labels,
                        reason=(
                            f"at the cap of {self.cap} open issues, and this does"
                            " not outrank anything already open. Staying quiet."
                        ),
                    ),
                )
            number, displaced = weakest
            self.board.withdraw(number, _why_withdrawn(displaced, seen, number))
            self._withdrew(displaced.signature, number, seen)
            withdrew = number

        number = self.board.file(title=title, body=body, labels=list(labels))
        reason = f"filed as #{number}"
        if withdrew is not None:
            reason += f", after withdrawing #{withdrew} to make room"
        return self._record(
            seen,
            entry,
            Filing(
                finding=seen,
                title=title,
                body=body,
                labels=labels,
                number=number,
                withdrew=withdrew,
                reason=reason,
            ),
        )

    def _render(self, finding: Finding) -> tuple[str, str, tuple[str, ...]]:
        return (
            finding.title(),
            finding.body(filed_by=self.reviewer.client_id),
            finding.labels(),
        )

    def _weakest(self, open_now: set[int]) -> tuple[int, Finding] | None:
        """The least of this filer's open issues, or nothing if it cannot tell.

        An open issue the ledger cannot account for is left alone rather than
        guessed at. Withdrawing something this filer does not understand would
        be the one move that cannot be undone from here, and "I have no record
        of it" is not evidence that it is unimportant.
        """
        ranked: list[tuple[tuple[int, int], int, Finding]] = []
        for signature, entry in self._entries().items():
            filed = entry.get("filed")
            if not filed or filed.get("withdrawn"):
                continue
            if filed["number"] not in open_now:
                continue
            finding = from_document(entry["finding"])
            ranked.append((finding.rank, filed["number"], finding))
        if len(ranked) < len(open_now):
            return None
        if not ranked:
            return None
        # Ties go to the older issue. An issue that has been open longest with
        # nobody acting on it is the one the board has already declined by not
        # doing anything about it, and the issue numbers say which that is
        # without anybody having to write down a date.
        _, number, finding = min(ranked, key=lambda entry: (entry[0], entry[1]))
        return number, finding

    # -- the ledger -----------------------------------------------------

    def _entry(self, signature: str) -> dict:
        return self._entries().get(signature, {})

    def _entries(self) -> dict[str, dict]:
        with self._on_ledger() as present:
            if not present:
                return {}
            found: dict[str, dict] = {}
            listed = self.store.git("ls-tree", "-r", "--name-only", LEDGER).splitlines()
            for name in listed:
                if not name.startswith("findings/"):
                    continue
                entry = json.loads(self.store.git("show", f"{LEDGER}:{name}"))
                found[entry["finding"]["signature"]] = entry
            return found

    def _recall(self, signature: str) -> Finding | None:
        entry = self._entry(signature)
        if not entry:
            return None
        return from_document(entry["finding"])

    def _record(self, finding: Finding, entry: dict, filing: Filing) -> Filing:
        written = dict(entry)
        written["finding"] = as_document(finding)
        if filing.number is not None and not written.get("filed"):
            written["filed"] = {"number": filing.number, "title": filing.title}
        written.setdefault("decisions", []).append(filing.reason)
        self._write(finding.signature, written, _message(finding, filing))
        return filing

    def _withdrew(self, signature: str, number: int, displaced_by: Finding) -> None:
        """Write the withdrawal down where the withdrawn thing lives.

        On the withdrawn finding rather than only on the one that displaced it,
        because the question somebody will ask is why *that* issue closed, and
        the answer has to be where they are standing when they ask it.
        """
        entry = self._entry(signature)
        entry["filed"]["withdrawn"] = {
            "number": number,
            "forSignature": displaced_by.signature,
            "reason": _why_withdrawn(from_document(entry["finding"]), displaced_by, number),
        }
        self._write(
            signature,
            entry,
            f"{signature[:8]}: withdrew #{number} for {displaced_by.signature[:8]}",
        )

    def _write(self, signature: str, entry: dict, message: str) -> None:
        with self._on_ledger():
            self.store.write(
                f"findings/{signature}.json", json.dumps(entry, indent=2) + "\n"
            )
            self.store.commit(message, self.reviewer)

    @contextmanager
    def _on_ledger(self):
        """Stand on the ledger branch, and put the working tree back afterwards.

        An episode commits with whatever branch is checked out, so a filer that
        wandered off and left the store somewhere else would silently write the
        next step of an in-flight episode into the ledger. Restoring is not
        politeness; it is the thing that keeps the two records apart.

        The branch is made with a plain `checkout -b` rather than through
        `start_branch`, which exists to write down where an *episode* began. The
        ledger has no beginning worth recording and contributes no range: it is
        one file per finding, appended to for as long as the store exists.
        """
        self.store.init(self.reviewer)
        was = self.store.current_branch()
        present = LEDGER in self.store.branches()
        if not present:
            self.store.git("checkout", "--quiet", "-b", LEDGER, "main")
        else:
            self.store.checkout(LEDGER)
        try:
            yield present
        finally:
            self.store.checkout(was)


def _order(occurrence) -> tuple[str, int]:
    return (occurrence.episode, occurrence.step)


def _message(finding: Finding, filing: Filing) -> str:
    head = f"{finding.signature[:8]}: {finding.kind} in {len(finding.episodes)}"
    head += " episode" if len(finding.episodes) == 1 else " episodes"
    if filing.number is not None:
        return f"{head}, filed as #{filing.number}"
    return head


def _why_withdrawn(displaced: Finding, displacing: Finding, number: int) -> str:
    """The reason a withdrawal gives, which is a comparison and not an apology.

    Generated, like everything else that leaves the machine, and phrased so the
    reader can check the arithmetic: what this was, what replaced it, and which
    of the two rules — kind, or how often — decided it.
    """
    reason = "how often it has been seen"
    if displaced.rank[0] != displacing.rank[0]:
        reason = "what kind of finding it is"
    return (
        f"Withdrawn by the agent that filed it. This filer is at its cap of open"
        f" issues and has found something it ranks higher, so it is spending the"
        f" slot rather than adding to the pile.\n\n"
        f"- withdrawn: #{number}, {displaced.kind}, seen in"
        f" {len(displaced.episodes)} episodes\n"
        f"- filed instead: {displacing.kind}, seen in"
        f" {len(displacing.episodes)} episodes\n\n"
        f"The two were separated by {reason}. The withdrawal is recorded against"
        f" the finding in the episode store; nothing about the occurrences was"
        f" deleted, and if this one recurs it can be filed again."
    )
