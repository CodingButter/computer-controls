"""What the log records, and what it must never record.

The second half is the one with teeth. The audit log is the fourth sink for the
values redaction exists to withhold, and the easiest to forget about, because a
log feels like a safe place to put things.
"""

from __future__ import annotations

import json

import pytest

from desktop_service import audit


@pytest.fixture
def log(tmp_path):
    return audit.AuditLog(tmp_path / "audit.jsonl", now=lambda: 1_700_000_000.5)


def record(**kwargs) -> audit.Record:
    base = dict(method="invokeElement", operation_class="submit", client_id="wren", decision="allowed")
    base.update(kwargs)
    return audit.Record(**base)


def test_a_call_becomes_one_line(log):
    log.write(record())
    assert len(log.path.read_text().splitlines()) == 1


def test_a_refusal_is_recorded_as_carefully_as_a_success(log):
    # An agent that tried to close a window and was told no is a fact about the
    # agent, and it is invisible in a log of what worked.
    log.write(record(decision="denied", reason="this client holds observe", error_code="PERMISSION_DENIED"))
    entry = log.tail()[0]
    assert entry["decision"] == "denied"
    assert entry["reason"] == "this client holds observe"
    assert entry["errorCode"] == "PERMISSION_DENIED"


def test_a_record_says_which_tier_answered_and_what_it_tried_first(log):
    log.write(record(backend="compositor", fallbacks=("accessibility",), duration_ms=120))
    entry = log.tail()[0]
    assert entry["backend"] == "compositor"
    assert entry["fallbacksUsed"] == ["accessibility"]
    assert entry["durationMs"] == 120


def test_a_record_carries_the_revision_range_it_covers(log):
    log.write(record(from_revision=7, to_revision=9))
    assert log.tail()[0]["revisions"] == [7, 9]


def test_every_record_is_valid_json_on_its_own_line(log):
    for index in range(5):
        log.write(record(client_id=f"client-{index}"))
    for line in log.path.read_text().splitlines():
        json.loads(line)


def test_the_log_is_appended_to_and_never_rewritten(log):
    log.write(record(client_id="first"))
    first_pass = log.path.read_text()
    log.write(record(client_id="second"))
    assert log.path.read_text().startswith(first_pass)


def test_a_second_log_on_the_same_file_appends_rather_than_truncating(tmp_path):
    # Several clients share one service, and a restarted service must not
    # begin by deleting the history of the one before it.
    first = audit.AuditLog(tmp_path / "audit.jsonl")
    first.write(record(client_id="before"))
    first.close()
    second = audit.AuditLog(tmp_path / "audit.jsonl")
    second.write(record(client_id="after"))
    assert len(second.tail()) == 2


def test_the_file_is_not_readable_by_other_users(log):
    log.write(record())
    assert log.path.stat().st_mode & 0o077 == 0


def test_tail_returns_oldest_first(log):
    for index in range(4):
        log.write(record(client_id=f"c{index}"))
    assert [entry["clientId"] for entry in log.tail(3)] == ["c1", "c2", "c3"]


def test_tail_of_a_log_that_does_not_exist_yet_is_empty(tmp_path):
    assert audit.AuditLog(tmp_path / "nothing.jsonl").tail() == []


def test_a_half_written_final_line_is_reported_rather_than_hidden(log):
    log.write(record())
    with open(log.path, "a", encoding="utf-8") as handle:
        handle.write('{"v": 1, "method": "inv')
    entries = log.tail()
    assert entries[-1]["unreadable"] is True


def test_a_write_failure_does_not_break_the_action_it_was_recording(tmp_path):
    # The action really happened. Turning a full disk into a failed desktop
    # call would be the wrong trade.
    log = audit.AuditLog(tmp_path / "nested" / "audit.jsonl")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested").chmod(0o500)
    try:
        log.write(record())
        assert log.health()["writeFailures"] == 1
        assert log.health()["lastError"]
    finally:
        (tmp_path / "nested").chmod(0o700)


def test_a_write_failure_is_visible_rather_than_silent(tmp_path):
    # Silence here looks exactly like a quiet desktop.
    log = audit.AuditLog(tmp_path / "nested" / "audit.jsonl")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested").chmod(0o500)
    try:
        log.write(record())
        health = log.health()
        assert health["written"] == 0 and health["writeFailures"] == 1
    finally:
        (tmp_path / "nested").chmod(0o700)


def test_a_record_has_no_field_for_element_text_at_all():
    # Not "we remember not to fill it in" — there is nowhere to put it.
    fields = set(audit.Record.__dataclass_fields__)
    for forbidden in ("value", "text", "title", "name", "contents", "typed"):
        assert forbidden not in fields


def test_the_serialised_record_carries_only_the_keys_we_chose(log):
    log.write(
        record(
            application="Text Editor",
            window_id="win-1",
            element_id="el-1",
        )
    )
    entry = log.tail()[0]
    allowed = {
        "v", "at", "method", "operationClass", "clientId", "decision", "reason",
        "application", "windowId", "elementId", "backend", "errorCode",
        "fallbacksUsed", "durationMs", "revisions",
    }
    assert set(entry) <= allowed, set(entry) - allowed


def test_a_record_has_nowhere_to_put_anything_else():
    # No free-form bag. A field meaning "anything else relevant" is the field
    # that eventually holds the contents of a text box, put there by somebody
    # debugging who meant to take it out again.
    with pytest.raises(TypeError):
        audit.Record(
            method="typeText", operation_class="edit", client_id="c",
            decision="allowed", detail={"typed": "hunter2"},
        )


def test_every_record_is_stamped_with_a_version(log):
    log.write(record())
    assert log.tail()[0]["v"] == audit.RECORD_VERSION


def test_the_timestamp_is_utc_and_sorts_lexicographically(log):
    log.write(record())
    at = log.tail()[0]["at"]
    assert at.endswith("Z")
    assert at.startswith("2023-11-14T")


def test_a_disabled_log_writes_nothing_and_says_so(tmp_path):
    log = audit.AuditLog(tmp_path / "audit.jsonl", enabled=False)
    log.write(record())
    assert not (tmp_path / "audit.jsonl").exists()
    assert log.health()["enabled"] is False
