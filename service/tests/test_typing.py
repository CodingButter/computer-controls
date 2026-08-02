"""Typing as a thing that takes time, and what happens when it is interrupted.

The live test proves text lands in a real application. These are about the parts
a live test cannot show on purpose: a toolkit that stops answering halfway
through a sentence, and a field that ends up saying something other than what
was asked for.
"""

from __future__ import annotations

import ast
import inspect
import textwrap

import pytest

from desktop_service import cadence, errors, server


class FakeElement:
    """Stands in for an accessible object, remembering what was typed into it."""

    def __init__(self, editable: bool = True, stall_after: int | None = None, refuse_after: int | None = None):
        self.text = ""
        self.editable = editable
        self.stall_after = stall_after
        self.refuse_after = refuse_after
        self.inserts = 0

    def insert(self, chunk: str) -> bool:
        if self.stall_after is not None and self.inserts >= self.stall_after:
            raise errors.DesktopError(errors.ErrorCode.TIMEOUT, "the toolkit did not answer")
        if self.refuse_after is not None and self.inserts >= self.refuse_after:
            return False
        self.inserts += 1
        self.text += chunk
        return True


@pytest.fixture
def typing(monkeypatch):
    """Wire the server's typing method to a fake element and no real waiting."""
    element = FakeElement()

    monkeypatch.setattr(server, "_resolve_element", lambda element_id: element)
    monkeypatch.setattr(server.loop, "call_on_loop", lambda work, timeout=None: work())
    # Typing resolves the window it is writing into before the first word, to
    # detect a person taking the field mid-sentence. That lookup is a real
    # toolkit call, reached through the patched call_on_loop above, so a fake
    # element is not enough on its own to keep this test off the accessibility
    # bus. Answering "no such window" is the honest fake: it is what a desktop
    # with nothing to take would say, and it exercises the real
    # _display_window_of rather than replacing it.
    monkeypatch.setattr(server.atspi, "find_window", lambda win_id: None)
    monkeypatch.setattr(server.atspi, "is_editable", lambda obj: obj.editable)
    monkeypatch.setattr(server.atspi, "insert_text", lambda obj, chunk, offset=-1: obj.insert(chunk))
    monkeypatch.setattr(server.atspi, "set_text_value", lambda obj, value: (setattr(obj, "text", value), True)[1])
    monkeypatch.setattr(
        server.atspi,
        "text_matches",
        lambda obj, expected, exact: server.atspi.verdict_for(obj.text, expected, exact=exact),
    )
    monkeypatch.setattr(server.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(server, "_snapshot", lambda: server.state.Snapshot(revision=1, windows={}, values={}))
    monkeypatch.setattr(server, "_element_scope", lambda element_id: ("win-a", "app-a"))
    return element


def type_text(**params):
    params.setdefault("elementId", "el-a")
    params.setdefault("settleMs", 0)
    return server._method_type_text(params)


def test_text_that_lands_is_reported_as_success(typing):
    result = type_text(text="hello there friend")
    assert result["ok"] is True
    assert typing.text == "hello there friend"
    assert result["progress"]["wordsTyped"] == result["progress"]["wordsPlanned"] == 3


def test_a_stalled_application_is_a_report_not_an_exception(typing):
    """Half a sentence is still on somebody's screen. Raising would hide that."""
    typing.stall_after = 2
    result = type_text(text="one two three four five")

    assert result["ok"] is False
    progress = result["progress"]
    assert progress["wordsTyped"] == 2
    assert progress["wordsPlanned"] == 5
    assert "stopped answering" in progress["stoppedBecause"]
    # And the caller can see exactly how much of it landed.
    assert typing.text == "one two "


def test_a_refused_insertion_stops_rather_than_typing_the_rest(typing):
    typing.refuse_after = 1
    result = type_text(text="one two three")
    assert result["ok"] is False
    assert result["progress"]["stoppedBecause"] == "the application refused an insertion"
    assert typing.text == "one "


def test_an_element_that_takes_no_text_is_refused_before_any_is_sent(typing):
    typing.editable = False
    result = type_text(text="anything")
    assert result["ok"] is False
    assert result["progress"]["wordsTyped"] == 0
    assert typing.text == ""


def test_success_is_the_readback_not_the_inserts(monkeypatch, typing):
    """A toolkit that accepts every insertion and keeps none of them still failed."""
    monkeypatch.setattr(server.atspi, "insert_text", lambda obj, chunk: True)
    result = type_text(text="into the void")
    assert result["ok"] is False
    assert result["progress"]["verified"] == "mismatch"
    assert result["progress"]["wordsTyped"] == 3  # every insert claimed to work


def test_replacing_clears_first_and_appending_does_not(typing):
    typing.text = "already here: "
    type_text(text="appended")
    assert typing.text == "already here: appended"

    type_text(text="replaced", replace=True)
    assert typing.text == "replaced"


def test_progress_reports_the_time_the_typing_was_expected_to_take(typing):
    text = "a sentence of some length to time"
    result = type_text(text=text, wordsPerMinute=70)
    assert result["progress"]["estimatedMs"] == cadence.estimate_ms(text, wpm=70)


# ---------------------------------------------------------------------------
# Editing: a splice, addressed by the text rather than by an offset.
# ---------------------------------------------------------------------------


@pytest.fixture
def editing(typing, monkeypatch):
    element = typing

    def find_range(obj, needle):
        if not needle:
            return None
        at = obj.text.find(needle)
        if at < 0 or obj.text.find(needle, at + 1) >= 0:
            return None
        return at, at + len(needle)

    def delete_text(obj, start, end):
        if start < 0 or end > len(obj.text) or start >= end:
            return False
        obj.text = obj.text[:start] + obj.text[end:]
        return True

    def insert_at(obj, chunk, offset=-1):
        at = len(obj.text) if offset < 0 else offset
        obj.text = obj.text[:at] + chunk + obj.text[at:]
        return True

    monkeypatch.setattr(server.atspi, "find_range", find_range)
    monkeypatch.setattr(server.atspi, "delete_text", delete_text)
    monkeypatch.setattr(server.atspi, "insert_text", insert_at)
    monkeypatch.setattr(server.atspi, "text_contains", lambda obj, needle: server.atspi.verdict_for(obj.text, needle, contains=True))
    monkeypatch.setattr(element, "selections", [], raising=False)
    monkeypatch.setattr(
        server.atspi,
        "select_text",
        lambda obj, start, end: (obj.selections.append((start, end)), True)[1],
    )
    return element


def code_of(function) -> str:
    """A function's executable code, with its prose left out.

    A docstring that promises never to synthesize a keystroke contains the word
    'keystroke', and a test that reads prose cannot tell a promise from a
    violation.
    """
    tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node):
            node.body = node.body[1:]
    return ast.unparse(tree)


def edit_text(**params):
    params.setdefault("elementId", "el-a")
    params.setdefault("settleMs", 0)
    return server._method_edit_text(params)


def test_a_replacement_lands_where_the_old_text_was(editing):
    editing.text = "the quick brown fox jumps"
    result = edit_text(find="brown", replaceWith="silver")
    assert result["ok"] is True
    assert editing.text == "the quick silver fox jumps"


def test_an_omitted_replacement_is_a_deletion(editing):
    editing.text = "keep this, drop that"
    result = edit_text(find=", drop that")
    assert result["ok"] is True
    assert editing.text == "keep this"
    assert result["progress"]["removed"] == len(", drop that")


def test_text_that_appears_twice_is_refused_rather_than_guessed_between(editing):
    """Two matches mean the caller does not know which one it meant."""
    editing.text = "delete the line, then delete the other"
    result = edit_text(find="delete", replaceWith="keep")
    assert result["ok"] is False
    assert result["progress"]["found"] is False
    assert editing.text == "delete the line, then delete the other"


def test_text_that_has_moved_on_is_not_found_rather_than_edited_wrongly(editing):
    """The whole reason edits are addressed by content instead of by offset."""
    editing.text = "somebody typed something else entirely"
    result = edit_text(find="the original sentence", replaceWith="new")
    assert result["ok"] is False
    assert "does not appear exactly once" in result["progress"]["stoppedBecause"]


def test_the_highlight_is_presentation_and_the_edit_does_not_need_it(editing):
    editing.text = "highlight me please"
    without = edit_text(find="me", replaceWith="us")
    assert without["ok"] is True
    assert editing.selections == []

    editing.text = "highlight me please"
    with_selection = edit_text(find="me", replaceWith="us", showSelection=True)
    assert with_selection["ok"] is True
    assert editing.selections == [(10, 12)]
    # Same outcome either way: the theatre changed nothing about the result.
    assert editing.text == "highlight us please"


def test_an_edit_that_vanished_is_a_failure_however_willing_the_toolkit_was(editing, monkeypatch):
    """The same rule as typing: success is the readback, not the acceptances.

    A toolkit that deletes the old text, agrees to every insertion and keeps
    none of it has left the field emptier than it found it — which is worse than
    doing nothing and must never be reported as ok.
    """
    editing.text = "replace THIS please"
    monkeypatch.setattr(server.atspi, "insert_text", lambda obj, chunk, offset=-1: True)

    result = edit_text(find="THIS", replaceWith="that")

    assert result["ok"] is False
    assert result["progress"]["verified"] == "mismatch"
    assert "that" not in editing.text


def test_a_deletion_that_did_not_happen_is_a_failure(editing, monkeypatch):
    monkeypatch.setattr(server.atspi, "delete_text", lambda obj, start, end: True)
    editing.text = "this text refuses to leave"

    result = edit_text(find="refuses to leave")

    assert result["ok"] is False
    assert result["progress"]["verified"] == "mismatch"


def test_typing_never_follows_focus_and_has_no_raw_input_fallback():
    """The rule that keeps this from being an auto-typer.

    An auto-typer sends keystrokes at whatever holds focus, so a user clicking
    into a chat window mid-sentence receives the rest of somebody else's
    paragraph. Here every word is addressed to one element, and the raw-input
    tier — which would follow focus — is not reachable from these methods at
    all. Asserted structurally so that adding a fallback later fails here rather
    than in somebody's message box.
    """
    source = code_of(server._method_type_text) + code_of(server._method_edit_text)
    for forbidden in ("x11.", "raw_input", "send_key", "keystroke", "grab_focus", "focus_window"):
        assert forbidden not in source, f"typing must not reach for {forbidden}"
    # And what it does reach for: an element, resolved by id, every time.
    assert "_resolve_element(element_id)" in source


def test_typing_addresses_the_element_even_while_focus_moves(typing, monkeypatch):
    """Focus moving mid-sentence changes nothing about where the words go."""
    focused = {"window": "win-a"}
    original = server.atspi.insert_text

    def insert_while_focus_wanders(obj, chunk, offset=-1):
        focused["window"] = "win-somebody-elses-chat"
        return original(obj, chunk, offset)

    monkeypatch.setattr(server.atspi, "insert_text", insert_while_focus_wanders)
    result = type_text(text="every word of this")
    assert result["ok"] is True
    assert typing.text == "every word of this"
    assert focused["window"] == "win-somebody-elses-chat"  # focus did move


def test_a_paced_replacement_types_into_the_gap_in_order(editing):
    """Each word goes in after the last, not all at the original offset."""
    editing.text = "before GAP after"
    result = edit_text(find="GAP", replaceWith="one two three", wordsPerMinute=200)
    assert result["ok"] is True
    assert editing.text == "before one two three after"
    assert result["progress"]["wordsTyped"] == 3


def test_a_field_that_masks_itself_is_unverifiable_rather_than_failed(typing, monkeypatch):
    element = typing
    # A GTK password entry hands the accessibility layer a row of bullets
    # instead of its contents — to us as much as to anyone. Calling that a
    # mismatch tells a caller its password did not go in when it did, and
    # invites it to type the thing a second time.
    monkeypatch.setattr(element, "text", "", raising=False)

    def masked_insert(obj, chunk, offset=-1):
        obj.text = "•" * (len(obj.text) + len(chunk))
        return True

    monkeypatch.setattr(server.atspi, "insert_text", masked_insert)
    result = type_text(text="my passphrase")
    assert result["progress"]["verified"] == "unverifiable"
    assert result["progress"]["wordsTyped"] == result["progress"]["wordsPlanned"]
    assert result["ok"] is True
    assert "masks its own contents" in result["progress"]["stoppedBecause"]


def test_an_empty_field_is_not_mistaken_for_a_masked_one():
    assert server.atspi.verdict_for("", "something") == "mismatch"


def test_text_that_is_genuinely_bullets_still_verifies():
    # Somebody typing "•••" into a notes app has to be able to confirm it.
    assert server.atspi.verdict_for("•••", "•••") == "verified"
