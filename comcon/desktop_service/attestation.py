"""Approval criteria: the rubric the worker does not write.

The send gate proves one thing — that a field's contents did not move between
attest and commit. This module is the vocabulary around that proof: which
criteria a commit is being judged against, who decided each one, and how the
answer is reported to somebody who is not the agent.

Three rules hold it together.

**The agent writes the argument, never the evidence.** The facts fed into
``evaluate`` are read by the service out of the toolkit. Nothing a caller sends
in a request reaches them, which is why this module takes an ``Observed``
record rather than a params dict: there is no field here for the agent to fill.

**The thing being judged does not write the rubric.** Criteria are declared on
the grant, by the client holding the door, and the mechanical set is always
evaluated on top of whatever was declared. A declared criterion can therefore
only ever add a question, never remove one — a rubric that could be narrowed by
the party being graded is not a rubric.

**A criterion the service cannot decide is UNCHECKED, never VERIFIED.** The
judgement criteria — is this the right recipient, does this say what the task
intended — are named here precisely so they can be reported as unanswered. A
proof that launders a claim into an official-looking field is worse than no
proof, because it reads as confirmation.
"""

from __future__ import annotations

from dataclasses import dataclass

#: How one criterion came out. Three values, not two: "I could not tell" is a
#: different fact from "I checked and it is wrong", and collapsing them is the
#: collapse that manufactures trust.
VERIFIED = "verified"
MISMATCH = "mismatch"
UNCHECKED = "unchecked"


@dataclass(frozen=True)
class Criterion:
    """One question asked of a commit, and who is able to answer it.

    ``mechanical`` is what makes the honest answer possible: a criterion the
    service cannot decide alone is marked here as such, and reporting it as
    verified is then not a judgement call but a contradiction in terms.
    """

    name: str
    mechanical: bool
    question: str


#: The target is the element that was named, and the service could still reach
#: it when the commit came. A commit against a target the service cannot resolve
#: is a commit to a destination the proof never saw.
TARGET_RESOLVED = Criterion(
    name="target-resolved",
    mechanical=True,
    question="Is the target the element that was named?",
)

#: The destination contains exactly the text read from it at attest time. This
#: is the send gate's own check, named here so it appears in the verdict a
#: reviewer reads rather than only as the reason for an exception.
CONTENTS_MATCH = Criterion(
    name="contents-match",
    mechanical=True,
    question="Does the destination contain exactly the text that was attested?",
)

#: Nothing changed between the proof and the commit — decided on the revision
#: the attestation was stamped with, not on the text. Contents-match alone
#: cannot see a field that changed and changed back, or a change that leaves
#: the text identical; the revision can. An approval refers to the desktop as
#: it was, and a desktop that has moved is a different desktop.
UNCHANGED_SINCE_PROOF = Criterion(
    name="unchanged-since-proof",
    mechanical=True,
    question="Has the desktop stayed still between the proof and the commit?",
)

#: Named, and deliberately never decidable here. A service that answered this
#: would be answering it from the same information the agent had, which is the
#: failure the whole amendment exists to prevent.
RIGHT_RECIPIENT = Criterion(
    name="right-recipient",
    mechanical=False,
    question="Is this going to the party the task intended?",
)

INTENT_MATCHES = Criterion(
    name="intent-matches",
    mechanical=False,
    question="Does this say what the task set out to say?",
)


#: Always evaluated, whatever the grant declares. These are the questions the
#: service can answer alone, and answering them is not a courtesy the caller
#: opts into: a commit that skipped them would be a commit with no proof at all.
MECHANICAL_CRITERIA: tuple[Criterion, ...] = (
    TARGET_RESOLVED,
    CONTENTS_MATCH,
    UNCHANGED_SINCE_PROOF,
)

#: Declarable on a grant. A criterion outside this set is still accepted and
#: still reported — as unchecked — because a rubric that silently dropped the
#: questions it did not recognise would report a clean sheet for a commit
#: nobody had actually asked the hard question about.
KNOWN_CRITERIA: tuple[Criterion, ...] = MECHANICAL_CRITERIA + (
    RIGHT_RECIPIENT,
    INTENT_MATCHES,
)

_BY_NAME = {criterion.name: criterion for criterion in KNOWN_CRITERIA}

#: What a grant may declare, for the schema and for refusal messages.
CRITERION_NAMES: tuple[str, ...] = tuple(criterion.name for criterion in KNOWN_CRITERIA)


@dataclass(frozen=True)
class Movement:
    """What happened to the attested element between the proof and the commit.

    Counted from the delta engine's own record, which is why this is about one
    element rather than about the desktop: the revision counter ticks for every
    window anybody touches, and a freshness rule that read it directly would
    call a commit stale because a clock updated in another workspace. The
    question is not whether the desktop moved. It is whether *this field* did.
    """

    #: Changes to the target caused by somebody other than the committing
    #: client. The ABA case lives here: a field edited and edited back reads as
    #: identical text, and only this count remembers that it moved at all.
    foreign: int = 0
    #: Changes to the target the service could not attribute to anyone. Counted
    #: apart from `foreign` because "somebody else did this" and "something did
    #: this and I cannot say what" deserve different answers.
    unattributed: int = 0
    #: Whether the change log still reaches back to the proof revision. False
    #: means the log has overflowed past it and silence proves nothing.
    complete: bool = True


def movement(element_id: str, delta: object) -> Movement:
    """Reduce a delta report to what it says about one element.

    Takes the dict `DeltaEngine.since` already produces, attribution and all.
    Recomputing attribution here would mean a second opinion about who caused
    what, and the delta engine's is the one the rest of the service acts on.
    """
    if not isinstance(delta, dict):
        return Movement(complete=False)
    foreign = 0
    unattributed = 0
    for change in delta.get("changes") or ():
        if not isinstance(change, dict) or change.get("elementId") != element_id:
            continue
        attribution = change.get("attribution")
        if attribution == "self":
            continue
        if attribution == "unattributed":
            unattributed += 1
        else:
            foreign += 1
    return Movement(
        foreign=foreign,
        unattributed=unattributed,
        complete=bool(delta.get("complete", False)),
    )


@dataclass(frozen=True)
class Observed:
    """What the service itself saw, assembled below the layer the agent reaches.

    Every field is filled from a toolkit read or from the service's own
    bookkeeping. There is deliberately no field a request could populate: the
    agent's argument for why a commit should happen travels in `reason` on the
    grant, and its evidence travels nowhere, because it has none to give.
    """

    #: Whether the named element was still resolvable when the commit arrived.
    target_resolved: bool
    #: Whether the field's contents still match what was attested. None when the
    #: comparison could not be made at all.
    contents_match: bool | None
    #: The revision the attestation was stamped at.
    proof_revision: int
    #: The revision the desktop was at when the commit was admitted.
    commit_revision: int
    #: What happened to the target in between.
    movement: Movement = Movement()


@dataclass(frozen=True)
class CriterionResult:
    """One criterion's verdict, in terms a reviewer can act on.

    ``detail`` carries facts about the outcome — which revision moved, what
    could not be reached — and never the contents of a field. The audit log is
    the one sink the redaction policy cannot reach after the fact.
    """

    criterion: Criterion
    verdict: str
    detail: str = ""


@dataclass(frozen=True)
class Verdict:
    """Every criterion a commit was judged against, and how each came out."""

    results: tuple[CriterionResult, ...]
    proof_revision: int

    @property
    def clean(self) -> bool:
        """Whether every mechanical criterion verified.

        Judgement criteria are excluded on purpose: they are unchecked by
        construction, and a gate that waited for them to verify would never
        open. They are carried to the reviewer, which is the whole point of
        reporting them rather than deciding them.
        """
        return all(
            result.verdict == VERIFIED
            for result in self.results
            if result.criterion.mechanical
        )

    @property
    def failures(self) -> tuple[CriterionResult, ...]:
        return tuple(
            result
            for result in self.results
            if result.criterion.mechanical and result.verdict != VERIFIED
        )

    @property
    def summary(self) -> str:
        """One line for the audit record: the stamp, then each verdict.

        Verdicts only. A reviewer reading this learns what was asked and how it
        came out, and nothing about what was in the field.
        """
        parts = [f"{result.criterion.name}={result.verdict}" for result in self.results]
        return f"r{self.proof_revision} " + " ".join(parts)


def resolve(names: object) -> tuple[Criterion, ...]:
    """Turn declared criterion names into criteria, mechanical set included.

    Unknown names survive as judgement criteria rather than being rejected: a
    client naming a question this service has not learned to answer is asking
    for it to reach a reviewer, and the honest response is to carry it through
    as unchecked. Refusing the grant instead would push the client towards
    declaring nothing, which is the outcome with the least review in it.
    """
    declared: list[Criterion] = list(MECHANICAL_CRITERIA)
    seen = {criterion.name for criterion in declared}
    for name in names or ():
        if not isinstance(name, str) or not name.strip():
            continue
        key = name.strip()
        if key in seen:
            continue
        seen.add(key)
        declared.append(
            _BY_NAME.get(key, Criterion(name=key, mechanical=False, question=""))
        )
    return tuple(declared)


def evaluate(criteria: tuple[Criterion, ...], observed: Observed) -> Verdict:
    """Judge one commit against its criteria, from what the service saw.

    The mechanical criteria are decided here. Everything else is reported
    unchecked and left for the reviewer — not because deciding it would be
    difficult, but because deciding it here would mean the service vouching for
    a judgement it is in no better position to make than the agent was.
    """
    results: list[CriterionResult] = []
    for criterion in criteria or MECHANICAL_CRITERIA:
        if not criterion.mechanical:
            results.append(
                CriterionResult(
                    criterion,
                    UNCHECKED,
                    detail="requires a reviewer; the service cannot decide this",
                )
            )
        elif criterion is TARGET_RESOLVED or criterion.name == TARGET_RESOLVED.name:
            results.append(
                CriterionResult(criterion, VERIFIED)
                if observed.target_resolved
                else CriterionResult(
                    criterion,
                    MISMATCH,
                    detail="the named element could not be resolved at commit time",
                )
            )
        elif criterion is CONTENTS_MATCH or criterion.name == CONTENTS_MATCH.name:
            if observed.contents_match is None:
                results.append(
                    CriterionResult(
                        criterion,
                        UNCHECKED,
                        detail="the field's contents could not be read back for comparison",
                    )
                )
            else:
                results.append(
                    CriterionResult(criterion, VERIFIED)
                    if observed.contents_match
                    else CriterionResult(
                        criterion,
                        MISMATCH,
                        detail="the destination no longer holds what was attested",
                    )
                )
        else:
            results.append(_freshness(criterion, observed))
    return Verdict(tuple(results), observed.proof_revision)


def _freshness(criterion: Criterion, observed: Observed) -> CriterionResult:
    """Did the attested field stay still between the photograph and the commit?

    Read from the change log rather than from the revision counter, because the
    counter is the whole desktop's and the approval was about one field. The
    order of the answers matters: an unreachable log is unchecked before
    anything else, since a log that cannot see the proof revision cannot report
    a clean field either — it can only report that it saw nothing, which is not
    the same fact and must never be dressed up as one.
    """
    moved = observed.movement
    if not moved.complete:
        return CriterionResult(
            criterion,
            UNCHECKED,
            detail=(
                f"the change log no longer reaches back to the proof "
                f"(r{observed.proof_revision}), so a change to this field "
                f"cannot be ruled out"
            ),
        )
    if observed.commit_revision < observed.proof_revision:
        return CriterionResult(
            criterion,
            UNCHECKED,
            detail=(
                f"the desktop's revision moved backwards between proof "
                f"(r{observed.proof_revision}) and commit (r{observed.commit_revision})"
            ),
        )
    if moved.foreign:
        return CriterionResult(
            criterion,
            MISMATCH,
            detail=(
                f"{moved.foreign} change(s) by another party touched this field "
                f"between the proof (r{observed.proof_revision}) and the commit "
                f"(r{observed.commit_revision})"
            ),
        )
    if moved.unattributed:
        return CriterionResult(
            criterion,
            UNCHECKED,
            detail=(
                f"{moved.unattributed} change(s) touched this field since the "
                f"proof (r{observed.proof_revision}) and the service cannot say "
                f"what caused them"
            ),
        )
    return CriterionResult(criterion, VERIFIED)
