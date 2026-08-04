"""Whether the diff is the delta, asked of the service's own diff engine.

The claim being tested is narrow and load-bearing: the files a commit touches
are exactly the things the delta named, and they got there without anybody
looking at the desktop a second time. A recorder that re-inspected would produce
a tidier tree and a dishonest one — it would show a desktop the acting agent was
never told about.

So every change here is produced by `state.diff`, the one engine in the service,
and the assertions are on the names in `git show --name-only`.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

from desktop_service import state

from recorder_tests.conftest import action, conformant, effects_of, snapshot, window

PACKAGE = Path(__file__).resolve().parents[1] / "episode_recorder"


def touched(store, ref: str = "HEAD") -> set[str]:
    listed = store.git("show", "--name-only", "--format=", ref).splitlines()
    return {line for line in listed if line}


def test_a_window_that_opened_becomes_a_file(recorder, agent):
    before = snapshot(1, window("win-a"))
    after = snapshot(2, window("win-a"), window("win-b", title="New Listing"))

    episode = recorder.open("sell the PS5", agent)
    episode.step("open the form", "invokeElement", "el-sell", action(before, after))

    assert touched(recorder.store) == {
        "steps/0001.json",
        "desktop/windows/win-b.json",
    }


def test_a_window_that_closed_stops_being_a_file(recorder, agent):
    before = snapshot(1, window("win-a"), window("win-b"))
    after = snapshot(2, window("win-a"))

    episode = recorder.open("tidy up", agent)
    episode.step("open it first", "invokeElement", "el-a", action(snapshot(0), before))
    episode.step("close it", "closeWindow", "win-b", action(before, after))

    assert "desktop/windows/win-b.json" in touched(recorder.store)
    assert not (recorder.store.path / "desktop/windows/win-b.json").exists()


def test_an_elements_value_moving_edits_that_elements_file_and_no_other(recorder, agent):
    before = snapshot(1, window("win-a"), values={"el-price": "500", "el-title": "PS5"})
    after = snapshot(2, window("win-a"), values={"el-price": "520", "el-title": "PS5"})

    episode = recorder.open("adjust the price", agent)
    episode.step("seed", "invokeElement", "el-a", action(snapshot(0), before))
    episode.step("raise it", "typeText", "el-price", action(before, after))

    assert touched(recorder.store) == {
        "steps/0002.json",
        "desktop/elements/el-price.json",
    }


def test_the_file_records_the_account_the_service_gave_not_the_value(recorder, agent):
    # `state.diff` says how a value changed and never what it changed to,
    # because the content is what the egress point exists to withhold. The tree
    # keeps the account and does not go looking for the rest.
    before = snapshot(1, window("win-a"), values={"el-note": "hello"})
    after = snapshot(2, window("win-a"), values={"el-note": "hello there"})

    episode = recorder.open("write a note", agent)
    episode.step("seed", "invokeElement", "el-a", action(snapshot(0), before))
    episode.step("add to it", "typeText", "el-note", action(before, after))

    document = json.loads(
        recorder.store.git("show", f"{episode.branch}:desktop/elements/el-note.json")
    )
    assert document["lastChange"]["kind"] == "element-value-changed"
    assert "characters" in document["lastChange"]["summary"]
    assert "hello there" not in json.dumps(document)


def test_focus_is_one_file_that_moves_rather_than_a_growing_list(recorder, agent):
    before = snapshot(1, window("win-a", active=True), window("win-b"))
    after = snapshot(2, window("win-a"), window("win-b", active=True))

    episode = recorder.open("switch windows", agent)
    episode.step("seed", "invokeElement", "el-a", action(snapshot(0), before))
    episode.step("focus the other one", "focusWindow", "win-b", action(before, after))

    assert "desktop/focus" in touched(recorder.store)
    assert (recorder.store.path / "desktop/focus").read_text() == "win-b\n"


def test_a_value_change_does_not_erase_what_an_earlier_change_established(recorder, agent):
    # `state.diff` names the application on a value change and never the window,
    # so a later thin change must fold onto the file rather than replace it.
    open_state = snapshot(
        1,
        window("win-a"),
        values={"el-price": "500"},
        owners={"el-price": ("app-1", "Test App")},
    )
    edited = snapshot(
        2,
        window("win-a"),
        values={"el-price": "520"},
        owners={"el-price": ("app-1", "Test App")},
    )
    episode = recorder.open("adjust a listing", agent)
    episode.step("seed", "invokeElement", "el-a", action(snapshot(0), open_state))
    episode.step("edit the price", "typeText", "el-price", action(open_state, edited))

    document = json.loads((recorder.store.path / "desktop/elements/el-price.json").read_text())
    assert document["applicationName"] == "Test App"
    assert document["lastChange"]["revision"] == 2


def test_a_closed_window_takes_its_elements_with_it(recorder, agent):
    # Otherwise the tree ends up claiming a desktop where elements outlive the
    # windows they lived in, which is not a desktop anybody has ever seen.
    #
    # `element-appeared` is in the change vocabulary but no snapshot diff emits
    # one yet, so this change is built by hand — and checked against the frozen
    # protocol, so a fixture cannot drift into a shape the service would never
    # send.
    appeared = conformant(
        kind="element-appeared",
        revision=2,
        windowId="win-b",
        elementId="el-price",
        applicationName="Test App",
        summary="an element appeared",
    )
    episode = recorder.open("abandon a listing", agent)
    episode.step(
        "open the form",
        "invokeElement",
        "el-sell",
        action(snapshot(0), snapshot(2, window("win-a"), window("win-b"))),
    )
    episode.step("read the price", "getElement", "el-price", effects_of(appeared))
    assert (recorder.store.path / "desktop/elements/el-price.json").exists()

    closed = snapshot(3, window("win-a"))
    episode.step(
        "close the window",
        "closeWindow",
        "win-b",
        action(snapshot(2, window("win-a"), window("win-b")), closed),
    )
    assert not (recorder.store.path / "desktop/windows/win-b.json").exists()
    assert not (recorder.store.path / "desktop/elements/el-price.json").exists()


def test_an_unchanged_desktop_still_commits_the_step(recorder, agent):
    # An action that changed nothing is a fact worth recording: it is how a
    # reader learns the agent tried this and it did not work.
    steady = snapshot(1, window("win-a"))
    episode = recorder.open("try something", agent)
    episode.step("press it", "invokeElement", "el-a", action(steady, steady))
    assert touched(recorder.store) == {"steps/0001.json"}


def test_a_later_thinner_change_does_not_leave_a_stale_last_change(recorder, agent):
    # A fuller change establishes the element; a later, thinner change — one that
    # does not name the window — folds on top. The committed document's
    # lastChange must describe the later change, not the earlier one it replaced,
    # and what the earlier change established that the later one does not name
    # (the window) must survive underneath it. An episode is committed forever,
    # and a lastChange that is subtly wrong about *when* something happened is
    # worse than one that is missing, because the missing one prompts a question
    # and the wrong one does not.
    appeared = conformant(
        kind="element-appeared",
        revision=1,
        windowId="win-a",
        elementId="el-price",
        applicationName="Test App",
        summary="the price field appeared",
    )
    flipped = conformant(
        kind="element-state-changed",
        revision=2,
        elementId="el-price",
        applicationName="Test App",
        summary="the price field flipped to checked",
    )
    episode = recorder.open("watch a listing", agent)
    episode.step(
        "it appears, then a state flips",
        "invokeElement",
        "el-price",
        effects_of(appeared, flipped),
    )

    document = json.loads(
        (recorder.store.path / "desktop/elements/el-price.json").read_text()
    )
    assert document["lastChange"]["revision"] == 2
    assert document["lastChange"]["kind"] == "element-state-changed"
    assert document["windowId"] == "win-a"


def test_the_recorder_never_reaches_for_the_service_or_a_socket():
    """The structural half of 'no second observation path'.

    Asserting on behaviour would only prove that the recorder did not re-inspect
    during a test. Asserting on the imports proves it cannot.
    """
    imported: set[str] = set()
    for source in PACKAGE.glob("*.py"):
        tree = ast.parse(source.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])

    assert "desktop_service" not in imported
    assert "socket" not in imported
    assert "asyncio" not in imported
