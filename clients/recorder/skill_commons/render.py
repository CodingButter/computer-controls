"""The two files a submission is, generated from the fields rather than written.

A submission is a **pair**, and the pair is the whole design.

`SKILL.md` is for the agent that will one day follow the route: the header the
Agent Skills specification asks for, and a body that is the route, step by step,
with the staleness signal attached to it. It is generated here, from a template,
out of enumerated fields — the same decision `finding.py` made about issue
bodies, for the same reason. Nothing an authoring agent typed reaches this file
except a slug, a version, a date and a landmark, each of which has been through
a shape check on the way in.

`REVIEW.md` is for the person who decides whether to merge it. It says what the
skill will have an agent *do* and what the evidence for each step is, and it is
deliberately not a summary of the skill in prose — a summary can be persuasive,
and a reviewer reading a persuasive summary of a poisoned skill is the failure
this whole gate exists to prevent. It is a checklist with the landmarks pulled
out of the route and put in front of the reviewer by name, because the landmarks
are the only place in a skill where a word the application chose can hide, and
deciding whether each one is a piece of chrome or somebody's name is the one
judgement no screen in this package can make.

A landmark that appears in the route and not in the review would be a step the
review could not justify. It cannot happen, because both files are generated
from the same tuple — which is the point of generating them rather than asking
for them.
"""

from __future__ import annotations

from . import frontmatter
from .skill import AMENDMENTS, Skill

#: What every published skill says about how much to trust it. Written here
#: rather than left to each author, because "this is advisory" is a property of
#: the commons and not an opinion a skill gets to hold about itself.
ADVISORY = (
    "This route is advisory. It is what worked on another machine, against the"
    " version named above. Verify each step against the tree in front of you —"
    " a landmark that is not there is a skill to amend, not a step to retry."
)


def describe(skill: Skill) -> str:
    """The one-line description the specification puts in the header.

    Assembled from the two slugs. An agent searching the commons matches
    against this, so it has to read like the task; it is generated so that it
    can only read like the task.
    """
    task = skill.task.replace("-", " ")
    app = skill.app.replace("-", " ")
    return (
        f"{task.capitalize()} in {app}. A route derived by an agent, verified"
        f" {skill.verification.successes} times against {app}"
        f" {skill.verification.app_version}."
    )


def header(skill: Skill) -> dict[str, object]:
    """The skill's frontmatter, as the SDK and the registry both read it."""
    return {
        "name": skill.name,
        "description": describe(skill),
        "metadata": {
            "app": skill.app,
            "task": skill.task,
            "app-version-verified": skill.verification.app_version,
            "last-verified": skill.verification.when,
            "verified-count": skill.verification.successes,
            "derived-by": skill.author.client_id,
            "signature": skill.signature,
        },
    }


def render(skill: Skill) -> str:
    """`SKILL.md`: the header, and the route as an agent will read it."""
    lines = [
        f"# {_title(skill)}",
        "",
        ADVISORY,
        "",
        "## The route",
        "",
        "| step | call | element | landmark |",
        "| --- | --- | --- | --- |",
    ]
    for step in skill.steps:
        role = f"`{step.role}`" if step.role else "—"
        landmark = f"`{step.landmark}`" if step.landmark else "—"
        lines.append(f"| {step.ordinal} | `{step.method}` | {role} | {landmark} |")

    lines += [
        "",
        "## Landmarks",
        "",
        _landmarks(skill),
        "",
        "## How stale this may be",
        "",
        f"Last verified against {skill.app.replace('-', ' ')}"
        f" {skill.verification.app_version} on {skill.verification.when}, after"
        f" {skill.verification.successes} successful runs. If the application in"
        " front of you is newer than that, the route may still be right and is"
        " no longer evidence.",
        "",
        "## Amendments",
        "",
        _amendments(skill),
        "",
        "## What is not here, and why",
        "",
        "No element ids, no window titles, no field contents, nothing read out"
        " of the application. An element id names one session and would make"
        " this a route that worked exactly once while looking like a route that"
        " worked. Everything else on that list is somebody's, and this file is"
        " on a public server forever.",
        "",
    ]
    return frontmatter.dump(header(skill)) + "\n" + "\n".join(lines)


def render_review(skill: Skill) -> str:
    """`REVIEW.md`: what a reviewer has to decide, and the evidence for it."""
    lines = [
        f"# Review: {_title(skill)}",
        "",
        f"Submitted by `{skill.author.client_id}`. Signature `{skill.signature}`.",
        "",
        "## What this skill has an agent do",
        "",
        f"{len(skill.steps)} steps against"
        f" {skill.app.replace('-', ' ')}, ending at the element the task names."
        " Every step is a read or a navigation issued through a protocol call"
        " named below; the commons publishes no scripts and no binaries, so"
        " nothing here executes on the machine that installs it.",
        "",
        "| step | call | why this step |",
        "| --- | --- | --- |",
    ]
    for step in skill.steps:
        lines.append(f"| {step.ordinal} | `{step.method}` | {_why(step)} |")

    lines += [
        "",
        "## The landmarks, which are the part to read",
        "",
        "A landmark is the only field in a skill that carries a word the"
        " application chose rather than one this package generated. The screens"
        " refuse anything shaped like an address, a key, a link or a card"
        " number, and they cannot tell a piece of chrome from somebody's name."
        " That judgement is the reason this file is in front of you.",
        "",
        _review_landmarks(skill),
        "",
        "## What was screened before this was opened",
        "",
        "- Every method, role and landmark passed the shapes in `skill.py`;"
        " a role is one of the closed vocabulary the accessibility layer uses.",
        "- The rendered text was scanned for addresses, telephone numbers,"
        " payment cards, links and key-shaped strings, and carried none.",
        f"- The route completed {skill.verification.successes} distinct times"
        " before it was submitted.",
        "- The application is not one whose contents the desktop service"
        " withholds.",
        "",
        "## What the screens could not answer",
        "",
        "Whether each landmark above is a fixed part of this application's"
        " interface or a word that was on the screen that day. Whether the route"
        " goes somewhere an agent following it should be going. Both are"
        " yes-or-no questions with the route in front of you, and neither is a"
        " question a pattern can be written for.",
        "",
    ]
    return "\n".join(lines)


def _title(skill: Skill) -> str:
    return f"{skill.app.replace('-', ' ')}: {skill.task.replace('-', ' ')}"


def _why(step) -> str:
    """The justification for one step, from the step's own fields.

    Generated, so that a step cannot be justified by an argument. What a
    reviewer gets is what the step actually says; if that is not enough to
    justify it, the step is the problem and the review has just said so.
    """
    if step.landmark and step.role:
        return f"reaches the `{step.role}` under `{step.landmark}`"
    if step.landmark:
        return f"navigates to `{step.landmark}`"
    if step.role:
        return f"acts on the `{step.role}` the previous step reached"
    return "no element named: this step is a call the route makes on its own"


def _landmarks(skill: Skill) -> str:
    if not skill.landmarks:
        return (
            "None. The route navigates by role and position alone, which is the"
            " least this file can say and the most it can promise."
        )
    return "\n".join(f"- `{landmark}`" for landmark in skill.landmarks)


def _review_landmarks(skill: Skill) -> str:
    if not skill.landmarks:
        return (
            "There are none. Nothing in this route carries a word the"
            " application chose."
        )
    lines = ["| landmark | first used at step | is this chrome? |", "| --- | --- | --- |"]
    for landmark in skill.landmarks:
        first = next(
            step.ordinal for step in skill.steps if step.landmark == landmark
        )
        lines.append(f"| `{landmark}` | {first} | reviewer decides |")
    return "\n".join(lines)


def _amendments(skill: Skill) -> str:
    if not skill.amendments:
        return "None. This is the route as it was first derived."
    lines = ["| what changed | step | version | when |", "| --- | --- | --- | --- |"]
    for amendment in skill.amendments:
        lines.append(
            f"| {AMENDMENTS[amendment.kind]} | {amendment.step} "
            f"| {amendment.app_version} | {amendment.when} |"
        )
    return "\n".join(lines)
