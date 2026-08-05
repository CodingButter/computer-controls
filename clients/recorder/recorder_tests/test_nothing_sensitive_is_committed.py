"""What must never reach a git object, proved by looking in every git object.

Agents are public. Episodes are not. The rest of this service already has a
value-egress point and a redaction policy, and the recorder inherits both by
only ever writing what already came through them — it re-implements nothing,
because a second policy is a second thing to get wrong.

But inheriting a guarantee is a claim, and this is the file that checks it, in
the only way worth checking: seed a password field, record real work over it,
then read back every object the store has ever written and go looking for the
secret. Git never forgets, so "we would have noticed" is not a safety property.

The searches are deliberately blunt. `git cat-file --batch-all-objects` reaches
loose objects, packed objects, unreachable ones and objects on branches nobody
merged, which is more than any code path in the recorder knows how to produce.
That is the point of asking the object store instead of asking the program.
"""

from __future__ import annotations

import json

import pytest

from desktop_service import model, redaction, state

from episode_recorder import Review
from recorder_tests.conftest import (
    action,
    everything_ever_written,
    snapshot,
    window,
)

SECRET = "hunter2-correct-horse"


@pytest.fixture(autouse=True)
def real_policy():
    """The service's own redaction policy, installed exactly as it is in production."""
    previous = model.get_value_policy()
    model.set_value_policy(redaction.default_policy())
    yield
    model.set_value_policy(previous)


def _keys(document) -> set[str]:
    """Every key name in a nested document, so a claim about fields is about fields."""
    found = set()
    if isinstance(document, dict):
        for key, value in document.items():
            found.add(key)
            found |= _keys(value)
    elif isinstance(document, list):
        for item in document:
            found |= _keys(item)
    return found


def test_a_password_field_is_recorded_without_the_password(recorder, agent):
    # The seeded secret is typed into a field the policy recognises as a
    # password field by its role — the same way it decides for every other
    # caller of this service.
    typed = model.egress_value(
        SECRET, field=model.VALUE, role="password text", element_id="el-password"
    )
    assert typed == redaction.MARKER, "the seeded field must actually be a password field"

    before = snapshot(1, window("win-a"), values={"el-password": ""})
    after = snapshot(2, window("win-a"), values={"el-password": typed})

    episode = recorder.open("log in to the marketplace", agent)
    episode.step("type the password", "typeText", "el-password", action(before, after))
    episode.close("logged in", worked=True)

    written = everything_ever_written(recorder.store)
    assert SECRET not in written
    assert "hunter2" not in written

    # Not even the marker appears, which is a stronger result than the one this
    # test was written expecting. The delta engine reports how a value changed
    # and never what it changed to, so there is no value on its way to the
    # recorder to redact: the password field is recorded as a field that grew.
    recorded = json.loads(
        recorder.store.git("show", f"{episode.branch}:desktop/elements/el-password.json")
    )
    assert "value" not in _keys(recorded)
    assert "characters at the end" in recorded["lastChange"]["summary"]
    # Withheld, not omitted: the field is still there to be talked about.
    assert recorded["elementId"] == "el-password"


def test_the_arguments_an_action_was_called_with_are_never_recorded(recorder, agent):
    """The hole a value-egress point cannot close on its own.

    Redaction governs what comes *out* of the service. What an agent typed *in*
    never passed through it — the client already had that string before it made
    the call. The audit log refuses to keep typed text for this reason, and a
    git object outlives an audit log, so the recorder refuses harder: there is
    no field on a step for the arguments, so there is nowhere for them to land.
    """
    steady = snapshot(1, window("win-a"))
    result = action(steady, steady)
    result["params"] = {"text": SECRET, "elementId": "el-password"}

    episode = recorder.open("log in", agent)
    episode.step("type the password", "typeText", "el-password", result)

    written = everything_ever_written(recorder.store)
    assert SECRET not in written
    record = json.loads(recorder.store.git("show", f"{episode.branch}:steps/0001.json"))
    assert "params" not in record
    # What it did and to what, which is the part a reader needs.
    assert record["method"] == "typeText"
    assert record["target"] == "el-password"


def test_a_window_title_the_policy_held_back_stays_held_back(recorder, agent):
    # A title is quoted into a change summary, and a password manager's window
    # is one the policy withholds by application rather than by role.
    before = snapshot(1, window("win-a"))
    after = snapshot(
        2,
        window("win-a"),
        state.WindowFacts(
            window_id="win-vault",
            application_id="app-2",
            application_name="Bitwarden",
            title=SECRET,
            role="frame",
            active=False,
        ),
    )

    episode = recorder.open("open the vault", agent)
    episode.step("open it", "invokeElement", "el-vault", action(before, after))

    assert SECRET not in everything_ever_written(recorder.store)


def test_a_reviewers_remark_is_searched_too(recorder, agent, reviewer):
    # A note is a git object like any other. A reviewer that quoted a secret
    # into a comment would have written it into the store just as permanently.
    steady = snapshot(1, window("win-a"))
    episode = recorder.open("do a thing", agent)
    episode.step("press it", "invokeElement", "el-a", action(steady, steady))

    review = Review(recorder.store.path, reviewer.author)
    review.remark(review.steps(episode.branch)[0], "this step was fine")

    written = everything_ever_written(recorder.store)
    assert "this step was fine" in written, "the search must actually reach notes"
    assert SECRET not in written


def test_where_a_thing_is_on_screen_cannot_be_recorded(recorder, agent):
    """Coordinates do not travel; semantics do.

    An episode recorded in pixels is a macro: it replays on the machine it was
    taken on and nowhere else, and it teaches a reader nothing about what the
    work was. Nothing is filtered here — the allowlists simply have no room for
    a coordinate, so one offered on a change is dropped on the way in.
    """
    steady = snapshot(1, window("win-a"))
    result = action(steady, steady)
    result["observedEffects"]["changes"] = [
        {
            "kind": "element-value-changed",
            "revision": 2,
            "elementId": "el-price",
            "summary": "an element's value was rewritten",
            "x": 1204,
            "y": 887,
            "boundingBox": {"x": 1204, "y": 887, "width": 96, "height": 24},
        }
    ]

    episode = recorder.open("click a thing", agent)
    episode.step("click it", "invokeElement", "el-price", result)

    written = everything_ever_written(recorder.store)
    assert "1204" not in written
    assert "boundingBox" not in written
    # The semantic half of the same change survived intact.
    assert "el-price" in written
