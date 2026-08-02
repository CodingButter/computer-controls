"""An episode: a branch, one commit per deliberate action, an outcome.

The mapping is the whole design, and it is a mapping onto a tool that already
exists rather than a new one:

===================  ==========================================================
a branch             one episode, named for what it set out to do
a commit             one deliberate action — not one twitch of the desktop
a commit message     the intent, in the words of whoever decided to act
a diff               what changed, as the service's own delta engine saw it
an author            the identity the service issued at the handshake
merged into main     it worked; this is how the task is done
an unmerged branch   an attempt that went sideways — still readable, not a lesson
a tag                the outcome, in the terms the work was actually judged on
===================  ==========================================================

An episode opens by declaration. An agent gets its start and end for free
because it knows when it began something; for a person, the sentence "pay
attention, I'm about to post something" is the branch name and the first commit
line, and there is nothing else to learn.

What an episode does *not* record is as deliberate as what it does. A step
carries the method and the element it named — never the arguments the method was
called with. Typed text is an argument, and typed text is the thing the audit
log refuses to keep for exactly the reason that applies here with more force: an
audit log is on somebody's disk and can be rotated, while a git object is
forever. The recorder is the fifth sink for the values the redaction module
exists to withhold, and it is the one with the longest memory.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from . import desktop_tree
from .store import Author, Store

#: What may be copied out of an action result. `progress` and `error` details
#: are summarised into trailers rather than committed whole: both are open
#: objects, and an open object is an unbounded promise about what gets written.
RESULT_FIELDS = ("actionId", "ok", "backend", "fallbacksUsed", "durationMs")

MAX_BRANCH = 60


@dataclass(frozen=True)
class Agent:
    """The agent as it stood when the episode began.

    Committed at the head of the branch, so that a reviewer reading the work has
    the instructions, the prompt, the tools and the model in front of them. A
    review that cannot see what the agent was told can only judge the outcome,
    and judging an outcome without the instructions is how a good agent gets
    blamed for a bad brief.
    """

    client_id: str
    label: str = ""
    instructions: str = ""
    prompt: str = ""
    tools: tuple[str, ...] = ()
    model: str = ""

    @property
    def author(self) -> Author:
        return Author(client_id=self.client_id, label=self.label)

    def files(self) -> dict[str, str]:
        return {
            "agent/instructions.md": _ending(self.instructions),
            "agent/prompt.md": _ending(self.prompt),
            "agent/tools.json": json.dumps(list(self.tools), indent=2) + "\n",
            "agent/model.txt": _ending(self.model),
        }


def _ending(text: str) -> str:
    return text if text.endswith("\n") else text + "\n"


def branch_name(intent: str) -> str:
    """A branch named the way somebody would say what they were doing.

    `sell the PS5` becomes `sell-the-ps5`. The name is the intent because the
    first question anybody asks a list of episodes is what each one was for.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", intent.lower()).strip("-")
    slug = slug[:MAX_BRANCH].strip("-")
    return slug or "episode"


class Recorder:
    """Opens episodes on one store."""

    def __init__(self, path) -> None:
        self.store = Store(path)

    def open(self, intent: str, agent: Agent) -> "Episode":
        self.store.init(agent.author)
        name = self._unused(branch_name(intent))
        self.store.checkout("main")
        self.store.start_branch(name)

        self.store.write("intent.md", _ending(intent))
        for relative, content in agent.files().items():
            self.store.write(relative, content)
        self.store.commit(intent, agent.author)
        return Episode(store=self.store, agent=agent, branch=name, intent=intent)

    def _unused(self, name: str) -> str:
        taken = set(self.store.branches())
        if name not in taken:
            return name
        # Two attempts at the same task are the normal case, not a collision to
        # be avoided: the second one wants its own branch and its own reading.
        attempt = 2
        while f"{name}-{attempt}" in taken:
            attempt += 1
        return f"{name}-{attempt}"


@dataclass
class Episode:
    store: Store
    agent: Agent
    branch: str
    intent: str
    steps: int = 0
    closed: bool = False
    tree: desktop_tree.DesktopTree = field(init=False)

    def __post_init__(self) -> None:
        self.tree = desktop_tree.DesktopTree(self.store)

    def step(self, intent: str, method: str, target: str, result: dict[str, Any]) -> str:
        """One deliberate action, committed.

        `result` is the action result the client already holds — the same object
        the service replied with. Its `observedEffects` are the diff.
        """
        if self.closed:
            raise RuntimeError("this episode is closed; open another one")

        self.steps += 1
        effects = result.get("observedEffects") or {}
        changes = [desktop_tree.carried(change) for change in effects.get("changes", [])]

        record: dict[str, Any] = {
            "step": self.steps,
            "intent": intent,
            "method": method,
            "target": target,
        }
        record.update({key: result[key] for key in RESULT_FIELDS if key in result})
        if effects:
            record["revisions"] = {
                "from": effects.get("fromRevision"),
                "to": effects.get("toRevision"),
            }
            if effects.get("partial"):
                record["partial"] = True
            if "settledMs" in effects:
                record["settledMs"] = effects["settledMs"]
        if not result.get("ok", True):
            record["error"] = _failure(result)
        record["changes"] = changes

        self.store.write(
            f"steps/{self.steps:04d}.json", json.dumps(record, indent=2) + "\n"
        )
        self.tree.apply(changes)
        return self.store.commit(_message(intent, record), self.agent.author)

    def close(self, outcome: str = "", *, worked: bool) -> None:
        """End the episode, and say whether it is canon.

        An episode that worked is merged into `main`: that is the claim that
        this is how the task is done, and it is the same claim a merged pull
        request makes. One that went sideways stays on its branch, readable by
        anybody who goes looking and taught to nobody who does not.
        """
        if self.closed:
            return
        tip = self.store.git("rev-parse", "HEAD")
        if outcome:
            self.store.git("tag", branch_name(outcome), tip, author=self.agent.author)
        if worked:
            self.store.checkout("main")
            self.store.git(
                "merge",
                "--quiet",
                "--no-ff",
                "--message",
                f"{self.intent} — worked",
                self.branch,
                author=self.agent.author,
            )
        self.closed = True


def _failure(result: dict[str, Any]) -> dict[str, Any]:
    error = result.get("error") or {}
    kept = {key: error[key] for key in ("code", "message") if key in error}
    return kept or {"code": "unknown"}


def _message(intent: str, record: dict[str, Any]) -> str:
    """The intent, then the facts a reader would otherwise open the file for."""
    trailers = [
        ("Method", record.get("method")),
        ("Target", record.get("target")),
        ("Action-Id", record.get("actionId")),
        ("Backend", record.get("backend")),
    ]
    if record.get("fallbacksUsed"):
        trailers.append(("Fallbacks-Used", ", ".join(record["fallbacksUsed"])))
    revisions = record.get("revisions") or {}
    if revisions.get("from") is not None:
        trailers.append(("Revision-Range", f"{revisions['from']}..{revisions['to']}"))
    if "settledMs" in record:
        trailers.append(("Settled-Ms", str(record["settledMs"])))
    if record.get("partial"):
        # A partial settle means effects may still be arriving, so this commit
        # is an honest but incomplete account. Saying so in the message keeps a
        # reader from reading the absence of a change as the absence of an
        # effect.
        trailers.append(("Partial", "true"))
    if "error" in record:
        trailers.append(("Failed", record["error"].get("code", "unknown")))

    lines = [f"{name}: {value}" for name, value in trailers if value]
    return f"{intent}\n\n" + "\n".join(lines) + "\n"
