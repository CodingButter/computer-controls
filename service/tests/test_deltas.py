"""The rules that make a delta trustworthy: who caused it, and who is asking."""

from __future__ import annotations

from desktop_service import actions, deltas, state


def snapshot(revision: int, windows: list[dict[str, object]]) -> state.Snapshot:
    return state.snapshot_from_windows(revision, windows)


def window(window_id: str, app: str = "app-1", title: str = "w", active: bool = False) -> dict:
    return {
        "id": window_id,
        "applicationId": app,
        "applicationName": "editor",
        "title": title,
        "role": "frame",
        "active": active,
    }


def record(
    action_id: str = "act-1",
    client_id: str = "client-a",
    first: int = 1,
    last: int = 3,
    scope_window: str = "win-1",
    scope_app: str = "app-1",
) -> actions.ActionRecord:
    return actions.ActionRecord(
        action_id=action_id,
        method="invokeElement",
        target_id="el-1",
        first_revision=first,
        last_revision=last,
        partial=False,
        client_id=client_id,
        scope_window_id=scope_window,
        scope_application_id=scope_app,
    )


def test_a_change_outside_every_action_range_is_external() -> None:
    log = actions.ActionLog()
    log.record(record(first=1, last=3))
    labelled = deltas.attribute({"kind": "window-opened", "applicationId": "app-1"}, 9, log)
    assert labelled["attribution"] == deltas.EXTERNAL


def test_a_change_in_range_and_in_scope_is_self_to_the_client_that_acted() -> None:
    log = actions.ActionLog()
    log.record(record(client_id="client-a"))
    labelled = deltas.attribute(
        {"kind": "window-opened", "applicationId": "app-1"}, 2, log, asking_client="client-a"
    )
    assert labelled["attribution"] == deltas.SELF
    assert labelled["detail"]["causedBy"] == "act-1"


def test_the_same_change_is_not_self_to_a_client_that_did_not_act() -> None:
    """Two agents on one desktop: one client's consequence is the other client's news."""
    log = actions.ActionLog()
    log.record(record(client_id="client-a"))
    labelled = deltas.attribute(
        {"kind": "window-opened", "applicationId": "app-1"}, 2, log, asking_client="client-b"
    )
    assert labelled["attribution"] == deltas.EXTERNAL
    assert labelled["detail"]["causedByClientId"] == "client-a"


def test_in_range_but_out_of_scope_is_unattributed_not_self() -> None:
    """A human opening a window mid-action must not be reported as the agent's doing."""
    log = actions.ActionLog()
    log.record(record(scope_window="win-1", scope_app="app-1"))
    labelled = deltas.attribute(
        {"kind": "window-opened", "applicationId": "app-other", "windowId": "win-other"},
        2,
        log,
        asking_client="client-a",
    )
    assert labelled["attribution"] == deltas.UNATTRIBUTED
    assert "causedBy" not in (labelled.get("detail") or {})


def test_a_new_window_from_the_same_application_is_in_scope() -> None:
    """An action that makes an app open a dialog caused that dialog."""
    log = actions.ActionLog()
    log.record(record(scope_window="win-1", scope_app="app-1"))
    labelled = deltas.attribute(
        {"kind": "window-opened", "applicationId": "app-1", "windowId": "win-dialog"},
        2,
        log,
        asking_client="client-a",
    )
    assert labelled["attribution"] == deltas.SELF


def test_the_engine_records_changes_once_and_replays_them_from_a_revision() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog())
    engine.observe(snapshot(1, [window("win-1")]))
    engine.observe(snapshot(2, [window("win-1"), window("win-2")]))

    from_zero = engine.since(0)
    from_one = engine.since(1)

    assert [change["kind"] for change in from_zero["changes"]] == [
        "window-opened",
        "window-opened",
    ]
    assert [change["kind"] for change in from_one["changes"]] == ["window-opened"]
    assert from_one["revision"] == 2
    assert from_one["complete"] is True


def test_a_caller_that_fell_behind_the_log_is_told_its_answer_is_incomplete() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog(), deltas.ChangeLog(limit=2))
    for revision in range(1, 6):
        engine.observe(snapshot(revision, [window(f"win-{i}") for i in range(revision)]))

    assert engine.since(0)["complete"] is False
    assert engine.since(4)["complete"] is True


def test_a_caller_that_fell_behind_is_given_a_cursor_that_loses_nothing_more() -> None:
    """`complete: false` alone tells a caller it lost information, not where to restart.

    The cursor has to be usable as-is: `since` is exclusive, so a resume point that named
    the oldest surviving change would silently drop that change on the way back.
    """
    engine = deltas.DeltaEngine(actions.ActionLog(), deltas.ChangeLog(limit=2))
    for revision in range(1, 6):
        engine.observe(snapshot(revision, [window(f"win-{i}") for i in range(revision)]))

    assert engine.since(0)["complete"] is False

    resumed = engine.since(engine.resume_revision)
    assert resumed["complete"] is True
    assert len(resumed["changes"]) == 2, "resuming from the cursor must yield the whole log"


def test_an_engine_that_never_dropped_anything_resumes_from_the_beginning() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog())
    engine.observe(snapshot(1, [window("win-1")]))

    assert engine.resume_revision == 0
    assert engine.since(0)["complete"] is True


def test_a_change_advances_the_revision_so_a_cursor_can_ever_catch_it() -> None:
    """`since` is exclusive, so a change recorded at the caller's own cursor is invisible.

    This is not theoretical: the engine originally stamped every snapshot with a counter
    that only element observation moved, so a client polling from its last known revision
    was told the desktop was quiet while windows opened in front of it.
    """
    ticks = iter(range(1, 100))
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: next(ticks))

    engine.observe(snapshot(0, [window("win-1")]))
    cursor = engine.since(0)["revision"]

    engine.observe(snapshot(0, [window("win-1"), window("win-2")]))
    caught = engine.since(cursor)

    assert [change["kind"] for change in caught["changes"]] == ["window-opened"]
    assert caught["revision"] > cursor


def test_an_observation_that_changed_nothing_does_not_move_the_revision() -> None:
    """A counter that ticked on every look would make quiet indistinguishable from busy."""
    ticks = iter(range(1, 100))
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: next(ticks))

    engine.observe(snapshot(0, [window("win-1")]))
    settled = engine.current.revision
    engine.observe(snapshot(0, [window("win-1")]))

    assert engine.current.revision == settled


def test_the_revision_never_walks_backwards() -> None:
    """Whoever sampled the desktop does not get to renumber history.

    A snapshot arrives stamped with whatever the sampler knew at the time, which can be
    older than what the engine has already published. Adopting it would hand out a cursor
    that starts matching changes the caller was already told about.
    """
    ticks = iter(range(10, 100))
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: next(ticks))

    engine.observe(snapshot(0, [window("win-1")]))
    published = engine.current.revision
    assert published >= 10

    engine.observe(snapshot(0, [window("win-1")]))

    assert engine.current.revision == published


# A written field is the one effect a windows-only observation could not see. The
# method reported success and no effects at all, which is two true statements that
# read together as a lie: the text had changed, and the only way to find out was to
# read it back by hand. These are the tests that were missing when it shipped.


def with_values(revision: int, values: dict[str, str]) -> state.Snapshot:
    return state.snapshot_from_windows(revision, [window("win-1")], values)


def test_a_written_field_is_a_change() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "before"}))

    changes = engine.observe(with_values(0, {"el-1": "after"}))

    assert [c["kind"] for c in changes] == ["element-value-changed"]
    assert changes[0]["elementId"] == "el-1"


def test_deleting_reads_differently_from_typing() -> None:
    """The catch that prompted this: a wipe and a keystroke produced one sentence.

    Four anonymous pulses arrived while a human emptied the field and typed into it,
    and nothing in the record said which was which — so the agent read the end state
    and narrated it as though it had watched.
    """
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "a paragraph somebody wrote"}))

    wiped = engine.observe(with_values(0, {"el-1": ""}))[0]
    engine.observe(with_values(0, {"el-1": "hi"}))
    typed = engine.observe(with_values(0, {"el-1": "hi there"}))[0]

    assert wiped["detail"]["shape"] == "cleared"
    assert wiped["detail"]["charactersRemoved"] == 26
    assert "cleared" in wiped["summary"]

    assert typed["detail"]["shape"] == "appended"
    assert typed["detail"]["charactersAdded"] == 6
    assert typed["detail"]["charactersRemoved"] == 0
    assert wiped["summary"] != typed["summary"]


def test_an_edit_in_the_middle_is_not_reported_as_an_append() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "the start and the end"}))

    change = engine.observe(with_values(0, {"el-1": "the start, then more, and the end"}))[0]

    assert change["detail"]["shape"] == "inserted"
    assert change["detail"]["unchangedPrefix"] == 9


def test_the_shape_of_an_edit_never_carries_its_content() -> None:
    """Lengths are safe where text is not, and this is the assertion that keeps it so."""
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "hunter2"}))

    change = engine.observe(with_values(0, {"el-1": "hunter2 and a secret"}))[0]

    rendered = repr(change)
    assert "secret" not in rendered
    assert "hunter2" not in rendered


def test_a_field_that_did_not_move_is_not_a_change() -> None:
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "same"}))

    assert engine.observe(with_values(0, {"el-1": "same"})) == []


def test_an_element_entering_the_watch_set_is_not_a_change() -> None:
    """Watching something for the first time says nothing about whether it moved.

    The watch set is bounded and recency-ordered, so elements drift in and out of it
    as a session inspects. Reporting an arrival as a value change would turn that
    drift into a stream of invented edits nobody made.
    """
    engine = deltas.DeltaEngine(actions.ActionLog(), advance=lambda: 1)
    engine.observe(with_values(0, {}))

    assert engine.observe(with_values(0, {"el-1": "first look"})) == []


def test_a_written_field_is_attributed_to_whoever_wrote_it() -> None:
    log = actions.ActionLog()
    log.record(record(action_id="act-7", client_id="typist", first=1, last=9))
    engine = deltas.DeltaEngine(log, advance=lambda: 1)
    engine.observe(with_values(0, {"el-1": "before"}))
    engine.observe(with_values(0, {"el-1": "after"}))

    mine = engine.since(0, asking_client="typist")["changes"][-1]
    theirs = engine.since(0, asking_client="somebody-else")["changes"][-1]

    assert mine["attribution"] == "self"
    assert theirs["attribution"] == "external"
    assert theirs["detail"]["causedByClientId"] == "typist"
