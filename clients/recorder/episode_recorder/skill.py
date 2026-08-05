"""A skill: a route through an application, written down only once it repeated.

An episode says what happened. A finding says what kept going wrong. Neither
says *how the task is done* — and that is the thing an agent re-derives from
nothing at the start of every session, walks half of, and then answers from.
A skill is that route, kept.

What a skill is, and what it is not:

===========================  ================================================
a skill                      a procedure: a task, the route to it, what bit
a route                      roles and names and landmarks, in descent order
a step of a route            *where* a thing is, never what it said
not a skill                  a fact — "Discord is at pid 4131" dies with the
                             process, and an element id dies with the session
===========================  ================================================

**Nothing becomes a skill the first time.** A route derived once is a
coincidence with a good story: the agent may have been lucky, or looking at one
account's layout, or reading a list that happened to be short. A route derived
twice is a route. That is the same bar the filer holds findings to, for the same
reason, and here it does a second job that matters more.

**The bar is also the redaction.** A first derivation is written down as
*hashes* — one salted digest per waypoint name, and never the name itself — so
the store physically cannot hold an un-agreed name. A name is written in clear
only when a later, independent derivation produces the same digest, which is to
say only when it has been shown to be a property of the application rather than
of what was on the screen that afternoon. A person's name in a message list, a
subject line, the text of the thing being looked for: all of it varies between
two runs, and everything that varies comes out as a hole in the route — "the
link whose name is what you are looking for" — rather than as a literal. There
is no scanner here deciding what looks like a secret. Agreement decides, and
agreement cannot be argued with.

Three further locks stand behind that one. The role of an element is held to the
same closed vocabulary a finding uses, so a role cannot be a sentence. The values
a derivation was working with are declared, and a waypoint whose name matches one
of them is holed even if two runs agreed — an agent that looked for the same
person twice has still learned nothing durable about the application. And the
rendered skill is refused outright, rather than sanitised, if a declared value
survives into it anywhere.

**A skill that can only rot is worse than no skill.** Applications move. When a
route no longer answers, the agent that discovers the breakage says so, and the
skill is marked as no longer standing on the spot — before anything is known
about where the route went, because a wrong map read confidently is the failure
this whole module exists to prevent. The replacement route then goes through the
same bar: derived twice, agreed, written, and the amendment records what moved.
So a skill is never silently abandoned and never quietly rewritten from a single
sighting.

The store is a git repository, like the episode store, and its `main` working
tree *is* a skills directory: one `SKILL.md` per task, in the front-matter shape
an agent harness already loads, with the machine-readable route beside it. The
history is the amendment record, which is why nothing here writes a date — git
already knows when a route last held, and a file that dated itself would be a
second answer to the same question. Candidates live on their own branch, so a
route that has been seen once is remembered without appearing to be advice.

Skills stay on the machine that learned them. Sharing them between machines is a
separate question with a supply-chain answer, and it is filed separately.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any

from .finding import ERROR, METHOD, ROLES
from .store import Author, Store

#: The branch a route seen once waits on. Not a skill, and deliberately not
#: stored where something reading the library for advice would find it.
CANDIDATES = "candidates"

#: How many independent derivations a route needs before it is a skill. The
#: filer's bar, held for a second reason: it is also what keeps an un-agreed
#: name from ever being written in clear.
BAR = 2

#: How many siblings make a list worth warning about. The number is not a
#: threshold on the data so much as a threshold on a reader: past about a
#: dozen, "I looked and it was not there" starts to mean "I looked at the top".
FOLD = 12

#: An application names itself in every window fact the service reports. Held
#: to a shape anyway, because this is a file that does not make assumptions.
APPLICATION = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}\Z")

#: What the skill is for, in the words an agent would use to ask for it —
#: `find a direct message by person`. Lower case and unpunctuated: a shape that
#: admits a task name and refuses a sentence somebody pasted.
TASK = re.compile(r"\A[a-z][a-z0-9 -]{0,79}\Z")

#: What the application called itself when the route last held. A version is a
#: version; it is not a place to write a note.
VERSION = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._+-]{0,39}\Z")

ROUTE = "route.json"
SKILL = "SKILL.md"


class NotDurable(ValueError):
    """A derivation refused before it could become a skill.

    Raised rather than sanitised, on the finding module's reasoning: a library
    that quietly dropped the part it did not like would hand back a route that
    is missing a step, and the agent following it would walk into the gap.
    """


def _folded(text: str) -> str:
    """A name reduced to what two sightings of it can be compared on.

    Compatibility normalisation first, because an application that writes a
    display name in mathematical bold codepoints is writing the same name — and
    an agent that matched on the raw string would miss it, which is precisely
    how a confident wrong answer gets given about a list the thing is sitting
    at the top of.
    """
    return unicodedata.normalize("NFKC", text).casefold().strip()


@dataclass(frozen=True)
class Anchor:
    """One waypoint, as the agent that walked the tree saw it.

    Lives in memory only. An anchor holds a name that has been read off the
    screen, and nothing writes an anchor to disk: what reaches the store is
    either a digest of this or a name two derivations agreed on.
    """

    role: str
    name: str = ""
    siblings: int = 0

    def __post_init__(self) -> None:
        if self.role not in ROLES:
            raise NotDurable(f"not a role the accessibility layer uses: {self.role!r}")
        if self.siblings < 0:
            raise NotDurable(f"a count of siblings cannot be {self.siblings}")

    @property
    def folded(self) -> str:
        return _folded(self.name)

    @property
    def stylized(self) -> bool:
        """Whether this name needs folding before it can be matched."""
        return bool(self.name) and unicodedata.normalize("NFKC", self.name) != self.name


@dataclass(frozen=True)
class Stumble:
    """A method that answered with an error on the way through, and recovered.

    Worth keeping because the next agent along will hit it too and has no way
    of knowing whether it means the route is wrong. Both fields are read out of
    a step record that already went through the service's allowlist, and both
    are held to a shape that cannot take a sentence.
    """

    method: str
    error: str

    def __post_init__(self) -> None:
        if not METHOD.fullmatch(self.method):
            raise NotDurable(f"not a method: {self.method!r}")
        if not ERROR.fullmatch(self.error):
            raise NotDurable(f"not an error code: {self.error!r}")


@dataclass(frozen=True)
class Derivation:
    """One agent's account of how it got there, this time.

    `bound` is what this run was actually looking for — the person, the label,
    the search term. It is declared so that it can be *excluded*: a waypoint
    whose name matches a bound value is holed rather than written, and the
    rendered skill is refused if a bound value survives into it anywhere.
    Nothing stores it.

    It has no default, and that is the point. Agreement between two runs
    already removes almost everything this protects against, but not the case
    where an agent looked for the same person twice — and a field that
    defaulted to empty would be a field nobody filled in on the day it
    mattered. `bound=()` is a claim that the route was not parameterised, made
    on purpose, at the call.
    """

    application: str
    task: str
    anchors: tuple[Anchor, ...]
    bound: tuple[str, ...]
    version: str = ""
    stumbles: tuple[Stumble, ...] = ()

    def __post_init__(self) -> None:
        if not APPLICATION.fullmatch(self.application):
            raise NotDurable(f"not an application name: {self.application!r}")
        if not TASK.fullmatch(self.task):
            raise NotDurable(
                f"not a task a skill can be named for: {self.task!r}."
                " A task is what an agent would ask for, in lower case words"
            )
        if self.version and not VERSION.fullmatch(self.version):
            raise NotDurable(f"not a version: {self.version!r}")
        if not self.anchors:
            raise NotDurable("a route with no waypoints is not a route")

    @property
    def slug(self) -> str:
        return f"{_slug(self.application)}/{_slug(self.task)}"


@dataclass(frozen=True)
class Waypoint:
    """One step of a route, as it is written down: agreed, or holed.

    `name` is only ever a name two derivations produced independently. `varies`
    says the opposite — that both saw a name here and they were different ones,
    which is the signature of the value the task is parameterised by.
    """

    role: str
    name: str = ""
    varies: bool = False
    stylized: bool = False
    siblings: int = 0

    @property
    def document(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "name": self.name,
            "varies": self.varies,
            "stylized": self.stylized,
            "siblings": self.siblings,
        }


def _waypoint(document: dict[str, Any]) -> Waypoint:
    return Waypoint(
        role=document["role"],
        name=document.get("name", ""),
        varies=bool(document.get("varies")),
        stylized=bool(document.get("stylized")),
        siblings=int(document.get("siblings", 0)),
    )


@dataclass(frozen=True)
class Skill:
    """A procedure that survived being derived twice."""

    application: str
    task: str
    waypoints: tuple[Waypoint, ...]
    stumbles: tuple[Stumble, ...] = ()
    version: str = ""
    derivations: int = BAR
    standing: bool = True
    changes: tuple[str, ...] = ()

    @property
    def slug(self) -> str:
        return f"{_slug(self.application)}/{_slug(self.task)}"

    @property
    def name(self) -> str:
        return f"{_slug(self.application)}-{_slug(self.task)}"

    @property
    def description(self) -> str:
        return f"Where to go in {self.application} to {self.task}."

    # -- what the route teaches, read out of the route ------------------

    def notes(self) -> tuple[str, ...]:
        """The gotchas, derived rather than written.

        There is no field for an agent to put advice in, for the reason there
        is no field for a reviewer to put prose in: a library that can be
        handed a sentence can be handed a password. Everything below is a
        consequence of the shape of the agreed route, so a skill can only warn
        about something two derivations actually saw.
        """
        said: list[str] = []
        for index, waypoint in enumerate(self.waypoints):
            if waypoint.name or waypoint.varies:
                continue
            below = [w for w in self.waypoints[index + 1:] if w.name or w.varies]
            if below:
                depth = len(self.waypoints) - index - 1
                said.append(
                    f"The **{waypoint.role}** at step {index + 1} carries no name of"
                    f" its own. Its identity is {depth} level"
                    f"{'' if depth == 1 else 's'} below it, on the"
                    f" **{below[0].role}** — a search that reads names at the"
                    " level of the row finds nothing and concludes, wrongly,"
                    " that the thing is not there."
                )
                break
        if any(waypoint.stylized for waypoint in self.waypoints):
            said.append(
                "Names here are written in compatibility codepoints rather than"
                " plain letters. Fold with NFKC before comparing, or an exact"
                " match misses a name that is on the screen in front of you."
            )
        crowded = [w for w in self.waypoints if w.siblings >= FOLD]
        if crowded:
            widest = max(crowded, key=lambda w: w.siblings)
            said.append(
                f"The **{widest.role}** list ran to {widest.siblings} items when"
                " this was learned. It is taller than one screenful: read to the"
                " end of it before answering that something is absent."
            )
        for stumble in self.stumbles:
            said.append(
                f"`{stumble.method}` answered `{stumble.error}` on the way"
                " through, both times, and the route still worked. It is a"
                " stumble on this path, not a sign of being on the wrong one."
            )
        return tuple(said)

    # -- what gets written ----------------------------------------------

    def render(self) -> str:
        """The skill as an agent reads it.

        Front matter first, in the shape a harness already loads, so a learned
        route is available the way any other skill is rather than through a
        reader written for this store. Everything below it is generated from
        the agreed route by the template in this file.
        """
        lines = [
            "---",
            f"name: {self.name}",
            f"description: {self.description}",
            "---",
            "",
            f"# {self.task[0].upper()}{self.task[1:]}, in {self.application}",
            "",
            f"Derived by an agent doing this for real, and written down only"
            f" because {self.derivations} independent attempts agreed about it."
            " Advisory, not a macro: verify each step against the live tree as"
            " you go, and if the route has moved, say so — a skill that is"
            " re-derived when it breaks is worth having, and one that can only"
            " rot is worse than nothing.",
            "",
        ]
        if not self.standing:
            lines += [
                "> **This route did not hold.** An agent walked it and it was"
                " not there. Treat it as a description of where things used to"
                " be, derive the route yourself, and record what you find:"
                " one more agreeing derivation replaces this.",
                "",
            ]
        lines += ["## The route", "", "Each step is inside the one above it.", ""]
        for index, waypoint in enumerate(self.waypoints, start=1):
            lines.append(f"{index}. {_step(waypoint)}")
        notes = self.notes()
        if notes:
            lines += ["", "## What to watch for", ""]
            lines += [f"- {note}" for note in notes]
        if self.changes:
            lines += ["", "## What changed at the last amendment", ""]
            lines += [f"- {change}" for change in self.changes]
        lines += [
            "",
            "## How far to trust it",
            "",
            (
                f"Last held against {self.application} {self.version}."
                if self.version
                else f"The version of {self.application} this last held against"
                " was not recorded."
            )
            + f" It has been derived the same way {self.derivations} times."
            " When that was is the last commit to this file: this store keeps"
            " no dates of its own, because git already has them and a file that"
            " dated itself would be a second answer to the same question.",
            "",
            "## What is not here, and why",
            "",
            "No message text, no titles, no field contents — nothing read out"
            " of the application beyond the names of the landmarks the route"
            " passes, and those only where two separate derivations produced"
            " the same name. Anything that differed between them is a hole in"
            " the route rather than a value. There are no element ids either,"
            " and no field to put one in: a handle is issued for one session"
            " and dies with it, so a route written in handles would be a route"
            " that has already expired.",
            "",
        ]
        return "\n".join(lines)

    @property
    def document(self) -> dict[str, Any]:
        return {
            "application": self.application,
            "task": self.task,
            "version": self.version,
            "derivations": self.derivations,
            "standing": self.standing,
            "waypoints": [waypoint.document for waypoint in self.waypoints],
            "stumbles": [
                {"method": stumble.method, "error": stumble.error}
                for stumble in self.stumbles
            ],
            "changes": list(self.changes),
        }


def _skill(document: dict[str, Any]) -> Skill:
    return Skill(
        application=document["application"],
        task=document["task"],
        waypoints=tuple(_waypoint(w) for w in document["waypoints"]),
        stumbles=tuple(
            Stumble(method=s["method"], error=s["error"])
            for s in document.get("stumbles", ())
        ),
        version=document.get("version", ""),
        derivations=int(document.get("derivations", BAR)),
        standing=bool(document.get("standing", True)),
        changes=tuple(document.get("changes", ())),
    )


def _step(waypoint: Waypoint) -> str:
    said = f"a **{waypoint.role}**"
    if waypoint.name:
        said += f" named `{waypoint.name}`"
    elif waypoint.varies:
        said += " whose name is the thing being looked for"
    else:
        said += ", which carries no name of its own"
    if waypoint.siblings >= FOLD:
        said += f" — {waypoint.siblings} of them were here"
    return said


@dataclass(frozen=True)
class Outcome:
    """What the library did with a derivation, and why.

    Always answers, written down or not. The refusals are the interesting
    cases — under the bar, or a route that no longer holds — and a refusal
    that did not show its work would be indistinguishable from a library that
    was broken.
    """

    status: str
    reason: str
    skill: Skill | None = None

    @property
    def written(self) -> bool:
        return self.status in ("written", "amended")


class SkillLibrary:
    """One machine's skills, as a git repository.

    `author` is the agent doing the deriving. It authors the commits, the way
    an episode's steps are authored by the client that took them, so that a
    library read six months later can be asked which agent learned what.
    """

    def __init__(self, path, author: Author) -> None:
        self.store = Store(path)
        self.author = author

    # -- reading --------------------------------------------------------

    def find(self, application: str, task: str) -> Skill | None:
        """The standing skill for a task, or nothing."""
        document = self._read("main", f"{_slug(application)}/{_slug(task)}/{ROUTE}")
        return None if document is None else _skill(json.loads(document))

    def skills(self) -> list[Skill]:
        """Every skill in the library, in path order."""
        found = []
        for name in self._listed("main"):
            if name.endswith(f"/{ROUTE}"):
                found.append(_skill(json.loads(self.store.git("show", f"main:{name}"))))
        return found

    def verified_at(self, skill: Skill) -> str:
        """When this route last held, asked of git rather than of the file."""
        return self.store.git(
            "log", "-1", "--format=%aI", "main", "--", f"{skill.slug}/{ROUTE}"
        )

    # -- the decision ---------------------------------------------------

    def derive(self, derivation: Derivation) -> Outcome:
        """Record how a task was done, and write it down if it has earned it."""
        self.store.init(self.author)
        identity = self.store.identity()
        standing = self.find(derivation.application, derivation.task)

        if standing is not None:
            return self._against_standing(standing, derivation, identity)

        candidate = self._candidate(derivation)
        if candidate is not None:
            agreed = _agreement(candidate["waypoints"], derivation, identity)
            if agreed is not None:
                skill = Skill(
                    application=derivation.application,
                    task=derivation.task,
                    waypoints=agreed,
                    stumbles=_shared_stumbles(candidate["stumbles"], derivation),
                    version=derivation.version,
                    derivations=BAR,
                )
                self._write(skill, derivation, f"{skill.slug}: learned")
                self._forget(derivation)
                return Outcome(
                    "written",
                    f"derived the same way {BAR} times: a route, not a coincidence",
                    skill,
                )

        self._remember(derivation, identity, "skill")
        return Outcome(
            "candidate",
            "derived once. Once is a coincidence with a good story:"
            " recorded as a candidate, not written down as a skill",
        )

    def _against_standing(
        self, standing: Skill, derivation: Derivation, identity: str
    ) -> Outcome:
        agreed = _agreement(
            [waypoint.document for waypoint in standing.waypoints], derivation, identity
        )
        if agreed is not None:
            held = replace(
                standing,
                waypoints=agreed,
                stumbles=_shared_stumbles(standing.stumbles, derivation),
                version=derivation.version or standing.version,
                derivations=standing.derivations + 1,
                standing=True,
            )
            self._write(
                held,
                derivation,
                f"{held.slug}: held, {held.derivations} derivations",
            )
            # A route that held retires any amendment waiting on it. The thing
            # the candidate was evidence for — that this skill had moved — has
            # just been contradicted by the application itself.
            self._forget(derivation)
            return Outcome("verified", "the route still holds", held)

        candidate = self._candidate(derivation)
        if candidate is not None and candidate.get("for") == "amendment":
            amended = _agreement(candidate["waypoints"], derivation, identity)
            if amended is not None:
                skill = Skill(
                    application=derivation.application,
                    task=derivation.task,
                    waypoints=amended,
                    stumbles=_shared_stumbles(candidate["stumbles"], derivation),
                    version=derivation.version,
                    derivations=BAR,
                    changes=_what_changed(standing.waypoints, amended),
                )
                self._write(skill, derivation, f"{skill.slug}: amended")
                self._forget(derivation)
                return Outcome(
                    "amended",
                    "the new route was derived twice and agreed:"
                    " the skill is rewritten and the change recorded",
                    skill,
                )

        # The breakage is written down before the replacement is known. A route
        # that is no longer there is dangerous the moment it is wrong, and
        # waiting for a second sighting to say so would leave an agent
        # following a map that this library already knows is a fiction.
        shaken = replace(standing, standing=False)
        self._write(shaken, derivation, f"{shaken.slug}: did not hold")
        self._remember(derivation, identity, "amendment")
        return Outcome(
            "shaken",
            "the route did not hold. The skill is marked as no longer standing"
            " and this derivation is a candidate to replace it",
            shaken,
        )

    # -- writing --------------------------------------------------------

    def _write(self, skill: Skill, derivation: Derivation, message: str) -> None:
        rendered = skill.render()
        route = json.dumps(skill.document, indent=2, sort_keys=True) + "\n"
        _refuse_bound(rendered + route, derivation.bound)
        with self._on("main"):
            self.store.write(f"{skill.slug}/{SKILL}", rendered)
            self.store.write(f"{skill.slug}/{ROUTE}", route)
            self._commit(message)

    def _remember(self, derivation: Derivation, identity: str, purpose: str) -> None:
        """Write a route down as digests, which is the only way it is written once.

        What is kept is the shape of the route and a salted digest per name.
        The salt is the store's own identity, which never leaves the machine,
        for the reason an episode id is salted: without it a digest is a
        confirmation oracle, and anybody holding the file could hash a list of
        likely names until one matched.
        """
        document = {
            "application": derivation.application,
            "task": derivation.task,
            "for": purpose,
            "waypoints": [
                {
                    "role": anchor.role,
                    "digest": _digest(identity, anchor),
                    "named": bool(anchor.name),
                    "stylized": anchor.stylized,
                    "siblings": anchor.siblings,
                }
                for anchor in derivation.anchors
            ],
            "stumbles": [
                {"method": stumble.method, "error": stumble.error}
                for stumble in derivation.stumbles
            ],
        }
        with self._on(CANDIDATES):
            self.store.write(
                self._candidate_path(derivation),
                json.dumps(document, indent=2, sort_keys=True) + "\n",
            )
            self._commit(f"{derivation.slug}: seen once, held as a {purpose} candidate")

    def _forget(self, derivation: Derivation) -> None:
        if self._candidate(derivation) is None:
            return
        with self._on(CANDIDATES):
            self.store.remove(self._candidate_path(derivation))
            self._commit(f"{derivation.slug}: candidate spent")

    def _candidate(self, derivation: Derivation) -> dict[str, Any] | None:
        document = self._read(CANDIDATES, self._candidate_path(derivation))
        return None if document is None else json.loads(document)

    def _candidate_path(self, derivation: Derivation) -> str:
        return f"{CANDIDATES}/{derivation.slug}.json"

    # -- the store ------------------------------------------------------

    def _ready(self) -> bool:
        return (self.store.path / ".git").exists()

    def _root(self) -> str:
        return self.store.git("rev-list", "--max-parents=0", "main").splitlines()[0]

    def _listed(self, branch: str) -> list[str]:
        if not self._ready() or branch not in self.store.branches():
            return []
        return self.store.git("ls-tree", "-r", "--name-only", branch).splitlines()

    def _read(self, branch: str, path: str) -> str | None:
        if path not in self._listed(branch):
            return None
        return self.store.git("show", f"{branch}:{path}")

    def _commit(self, message: str) -> None:
        # A re-derivation that changed nothing is a real and common outcome,
        # and an empty commit would make the history read as though something
        # moved. The count of derivations is in the route, so a verification
        # that mattered has already changed the file.
        if self.store.git("status", "--porcelain"):
            self.store.commit(message, self.author)

    @contextmanager
    def _on(self, branch: str):
        """Stand on a branch, and put the working tree back afterwards.

        `main` is the library — its working tree is the skills directory
        something else reads — so a call that wandered onto the candidates
        branch and left it there would empty that directory under a reader.
        Restoring is not politeness; it is what keeps the two apart.
        """
        self.store.init(self.author)
        was = self.store.current_branch()
        if branch != was:
            if branch in self.store.branches():
                self.store.checkout(branch)
            else:
                # From the root commit rather than from `main`, so the branch
                # for routes that are not advice yet does not begin as a copy
                # of the ones that are. Two records that share a tree are two
                # records somebody will eventually read as one.
                self.store.git("checkout", "--quiet", "-b", branch, self._root())
        try:
            yield
        finally:
            if self.store.current_branch() != was:
                self.store.checkout(was)


# -- agreement ----------------------------------------------------------


def _digest(identity: str, anchor: Anchor) -> str:
    return hashlib.sha256(
        f"{identity}\x00{anchor.role}\x00{anchor.folded}".encode()
    ).hexdigest()[:16]


def _expected(identity: str, was: dict[str, Any]) -> str:
    """The digest a waypoint's name has to produce to count as the same name.

    A candidate holds the digest and never the name. A standing skill holds the
    name, because it has already been agreed and there is nothing left to
    protect — so it is hashed here, on the way into the comparison, rather than
    the two records being made to look alike on disk.
    """
    if "digest" in was:
        return was["digest"]
    return _digest(identity, Anchor(role=was["role"], name=was.get("name", "")))


def _agreement(
    before: list[dict[str, Any]], derivation: Derivation, identity: str
) -> tuple[Waypoint, ...] | None:
    """What two derivations of the same task both say, or nothing.

    Positional over the descent, and strict about it: two routes agree when
    they have the same roles in the same order. A different sequence is not a
    worse version of this route, it is a different route, and merging them
    would produce a path neither agent ever walked.

    The names are where the caution lives. A name survives only when both
    sightings produced it; anything else becomes a hole, marked as varying if
    both saw *a* name and they differed. That is the whole redaction: what
    varies between two runs is what the run was about, and what the run was
    about is the one thing that must not be written down.
    """
    if len(before) != len(derivation.anchors):
        return None

    bound = tuple(_folded(value) for value in derivation.bound if value.strip())
    agreed: list[Waypoint] = []
    for was, now in zip(before, derivation.anchors):
        if was["role"] != now.role:
            return None

        named = bool(was["named"]) if "named" in was else bool(was.get("name"))
        if was.get("varies"):
            # A slot the route already knows varies agrees with any name, and
            # with nothing else: an empty one means the identity has moved off
            # this element, which is a change to the route rather than a match.
            if not now.name:
                return None
            name, varies = "", True
        elif named and now.name:
            same = _expected(identity, was) == _digest(identity, now)
            hit = any(value in now.folded for value in bound)
            name, varies = (now.name, False) if same and not hit else ("", True)
        elif not named and not now.name:
            name, varies = "", False
        else:
            name, varies = "", True

        # The two counts and the two flags are taken at their widest rather
        # than agreed. A name is held to agreement because a name is content;
        # a count and a boolean are neither, and the warnings they produce are
        # about how to search rather than about what is there. A list that was
        # short once and long once is a long list, and a place where one
        # sighting needed folding is a place to fold.
        agreed.append(
            Waypoint(
                role=now.role,
                name=name,
                varies=varies,
                stylized=bool(was.get("stylized")) or now.stylized,
                siblings=max(int(was.get("siblings", 0)), now.siblings),
            )
        )
    return tuple(agreed)


def _shared_stumbles(seen: Any, derivation: Derivation) -> tuple[Stumble, ...]:
    """The errors both derivations hit. A stumble seen once is weather."""
    known = {
        (s["method"], s["error"]) if isinstance(s, dict) else (s.method, s.error)
        for s in seen
    }
    return tuple(
        stumble
        for stumble in derivation.stumbles
        if (stumble.method, stumble.error) in known
    )


def _what_changed(
    before: tuple[Waypoint, ...], after: tuple[Waypoint, ...]
) -> tuple[str, ...]:
    """What moved, in the terms the route is written in.

    Generated by comparing the two routes rather than accepted from whoever
    amended it, for the reason nothing else here takes a sentence. It is also
    the more useful record: an agent that says "Discord changed" has told the
    next reader nothing, and "step 3 is a tree item now, not a list item" has
    told them where to look.
    """
    said: list[str] = []
    if len(before) != len(after):
        said.append(
            f"The route was {len(before)} steps and is now {len(after)}."
        )
    for index, (was, now) in enumerate(zip(before, after), start=1):
        if was.role != now.role:
            said.append(f"Step {index} was a {was.role} and is now a {now.role}.")
        elif was.name and now.name and was.name != now.name:
            said.append(f"Step {index} is named `{now.name}` now.")
        elif was.name and not now.name:
            said.append(
                f"Step {index} no longer answers to the name it had;"
                " it is matched by role alone."
            )
        elif now.name and not was.name:
            said.append(f"Step {index} carries a name of its own now: `{now.name}`.")
    if not said:
        said.append("The same steps, re-derived; nothing about the route moved.")
    return tuple(said)


def _refuse_bound(rendered: str, bound: tuple[str, ...]) -> None:
    """The last gate: what the run was looking for is not in what it wrote.

    Agreement should already have holed every one of these, so this check is a
    second lock on a door that is closed — and it is here for the case
    agreement cannot see, which is a value that reached the file by some route
    other than a waypoint name. It refuses rather than redacts.
    """
    haystack = _folded(rendered)
    for value in bound:
        folded = _folded(value)
        if folded and folded in haystack:
            raise NotDurable(
                "a value this derivation was looking for survived into the"
                " skill. A skill says where things are, never what they said"
            )


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "unnamed"
