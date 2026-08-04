"""Typing at a window instead of into an element, and what that costs.

Every other write in this service addresses the element it writes to. This one
addresses the keyboard, which is only pointed at the intended element for as
long as that stays true — so these tests are mostly about the conditions under
which the method refuses to type at all, and about the proof it produces when it
does. The mechanism is dumb on purpose. The tests are about the honesty bolted
to it.

Nothing here needs a desktop. The synthesis primitives are the boundary: past
them is the X server, and a test that reached it would be typing into whatever
window the person running the suite had open.
"""

from __future__ import annotations

import pytest

from desktop_service import errors, holds, server


class FakeField:
    """An element that reads back but cannot be written through — the whole case.

    Deliberately without an `insert` or an editable-text interface, because the
    field this tier exists for does not have one either. What it has is text
    that can be read, which is what the verification hangs off.
    """

    def __init__(self, focusable: bool = True):
        self.text = ""
        self.focusable = focusable
        self.focused = 0

    def focus(self) -> bool:
        self.focused += 1
        return self.focusable


@pytest.fixture
def keyboard(monkeypatch):
    """Wire the method to a fake field and a keyboard that goes nowhere real."""
    field = FakeField()
    sent: list[str] = []

    def type_keysym(keysym: int) -> bool:
        character = chr(keysym)
        sent.append(character)
        field.text += character
        return True

    waits: list[float] = []

    monkeypatch.setattr(server, "_resolve_element", lambda element_id: field)
    # The pace is real and is asserted below; a suite that slept through it would
    # take a minute to type three sentences nobody is watching.
    monkeypatch.setattr(server.time, "sleep", waits.append)
    monkeypatch.setattr(server.loop, "call_on_loop", lambda work, timeout=None: work())
    # Same honest fake the typing tests use: a desktop with no such window says
    # so, which exercises the real _display_window_of rather than replacing it.
    monkeypatch.setattr(server.atspi, "find_window", lambda win_id: None)
    monkeypatch.setattr(server.atspi, "grab_focus", lambda obj: obj.focus())
    monkeypatch.setattr(server.atspi, "type_keysym", type_keysym)
    monkeypatch.setattr(
        server.atspi,
        "clear_field_by_keystrokes",
        lambda: (setattr(field, "text", ""), True)[1],
    )
    monkeypatch.setattr(
        server.atspi,
        "text_matches",
        lambda obj, expected, exact: server.atspi.verdict_for(obj.text, expected, exact=exact),
    )
    monkeypatch.setattr(server.atspi, "read_back", lambda obj, element_id="": obj.text)
    monkeypatch.setattr(server, "_snapshot", lambda: server.state.Snapshot(revision=1, windows={}, values={}))
    monkeypatch.setattr(server, "_element_scope", lambda element_id: ("win-a", "app-a"))
    field.sent = sent
    field.waits = waits
    return field


def type_keystrokes(**params):
    params.setdefault("elementId", "el-a")
    params.setdefault("settleMs", 0)
    return server._method_type_keystrokes(params)


def test_text_that_lands_is_reported_as_success(keyboard):
    result = type_keystrokes(text="hello there")
    assert result["ok"] is True
    assert keyboard.text == "hello there"
    progress = result["progress"]
    assert progress["charactersTyped"] == progress["charactersPlanned"] == 11
    assert progress["verified"] == "verified"


def test_keys_are_spaced_out_because_an_application_can_drop_the_ones_it_is_not_ready_for(
    keyboard,
):
    """Pacing here is mechanism, not presentation.

    `typeText` hands a whole word to the toolkit in one call and the toolkit
    takes all of it. These go through the X server one at a time, and an
    application still laying out the last character never sees the next one. The
    wait is per character for the same reason the typing is.
    """
    result = type_keystrokes(text="hello", wordsPerMinute=60)

    assert len(keyboard.waits) == 4  # One before every character except the first.
    assert keyboard.waits == [pytest.approx(0.2)] * 4
    assert result["progress"]["estimatedMs"] == 1000


def test_a_field_that_will_not_take_focus_is_refused_before_any_key_is_sent(keyboard):
    """The one refusal that matters most: no focus means no target.

    Typing anyway would put the text in whichever window happens to be in front,
    which is the failure the rest of this service is built to make impossible.
    """
    keyboard.focusable = False
    result = type_keystrokes(text="anything at all")

    assert result["ok"] is False
    assert keyboard.sent == []
    assert keyboard.text == ""
    assert "would not take keyboard focus" in result["progress"]["stoppedBecause"]


def test_the_window_that_was_raised_is_reported(keyboard, monkeypatch):
    """Focus was stolen. A caller whose text went astray needs somewhere to look."""
    monkeypatch.setattr(server, "_display_window_of", lambda element_id: "3001")
    result = type_keystrokes(text="hi")
    assert result["progress"]["focusedWindow"] == "3001"


def test_the_backend_is_reported_honestly(keyboard):
    """No pretending this was the accessibility write. It is not, and it costs more."""
    result = type_keystrokes(text="hi")
    assert result["backend"] == "keystrokes"
    assert result["fallbacksUsed"] == []


def test_a_mismatched_readback_is_a_failure_carrying_what_actually_landed(keyboard, monkeypatch):
    """Half-typed is a real state of the world, so it is reported rather than raised.

    Keys already sent cannot be recalled. A caller told only "it failed" would
    have no way to know whether the field is empty or holds most of a message.
    """
    def drop_after_three(keysym: int) -> bool:
        if len(keyboard.text) >= 3:
            return True  # the X server took it; the application did not keep it
        keyboard.text += chr(keysym)
        return True

    monkeypatch.setattr(server.atspi, "type_keysym", drop_after_three)
    result = type_keystrokes(text="a whole sentence")

    assert result["ok"] is False
    progress = result["progress"]
    assert progress["verified"] == "mismatch"
    assert progress["actualText"] == "a w"
    # Every key was accepted by the keyboard, which is exactly why the count is
    # not the proof and the read-back is.
    assert progress["charactersTyped"] == progress["charactersPlanned"]


def test_a_refused_key_stops_rather_than_typing_the_rest(keyboard, monkeypatch):
    def refuse_after_four(keysym: int) -> bool:
        if len(keyboard.text) >= 4:
            return False
        keyboard.text += chr(keysym)
        return True

    monkeypatch.setattr(server.atspi, "type_keysym", refuse_after_four)
    result = type_keystrokes(text="one two three")

    assert result["ok"] is False
    assert result["progress"]["stoppedBecause"] == "the keyboard event was refused"
    assert result["progress"]["charactersTyped"] == 4
    assert keyboard.text == "one "


def test_a_stalled_application_is_a_report_not_an_exception(keyboard, monkeypatch):
    def stall_after_three(keysym: int) -> bool:
        if len(keyboard.text) >= 3:
            raise errors.DesktopError(errors.ErrorCode.TIMEOUT, "the toolkit did not answer")
        keyboard.text += chr(keysym)
        return True

    monkeypatch.setattr(server.atspi, "type_keysym", stall_after_three)
    result = type_keystrokes(text="one two three")

    assert result["ok"] is False
    assert "stopped answering" in result["progress"]["stoppedBecause"]
    assert keyboard.text == "one"


def test_replacing_clears_the_field_first_and_appending_does_not(keyboard):
    keyboard.text = "already here: "
    assert type_keystrokes(text="appended")["ok"] is True
    assert keyboard.text == "already here: appended"

    assert type_keystrokes(text="replaced", replace=True)["ok"] is True
    assert keyboard.text == "replaced"


def test_a_masked_field_is_unverifiable_rather_than_failed(keyboard, monkeypatch):
    """Same rule the toolkit path uses: the alternative is retyping a password."""
    monkeypatch.setattr(server.atspi, "type_keysym", lambda keysym: True)
    monkeypatch.setattr(keyboard, "text", "••••••")
    result = type_keystrokes(text="secret")

    assert result["ok"] is True
    assert result["progress"]["verified"] == "unverifiable"


def test_a_newline_is_refused_by_name_because_return_is_the_send_button(keyboard):
    """The load-bearing refusal. Enter in a chat composer posts the message.

    This tier exists to type into chat composers. If a newline in a string were
    typed as a key, this method could send a message, and committing a message
    is a separate act behind its own gate.
    """
    with pytest.raises(errors.DesktopError) as raised:
        type_keystrokes(text="first line\nsecond line")

    assert raised.value.code == errors.ErrorCode.INVALID_PARAMS
    assert "\n" in raised.value.detail["characters"]
    assert keyboard.sent == []


def test_characters_with_no_keysym_are_refused_before_any_are_typed(keyboard):
    """All or nothing, checked up front.

    Discovering an untypeable character at position three hundred would leave two
    hundred and ninety-nine of them on somebody's screen and nothing to say about
    the remainder.
    """
    with pytest.raises(errors.DesktopError) as raised:
        type_keystrokes(text="a perfectly fine sentence 😀 with one problem")

    assert raised.value.code == errors.ErrorCode.INVALID_PARAMS
    assert raised.value.detail["characters"] == ["😀"]
    assert keyboard.sent == []
    assert keyboard.text == ""


def test_latin1_beyond_ascii_is_typed_rather_than_refused(keyboard):
    result = type_keystrokes(text="café façade")
    assert result["ok"] is True
    assert keyboard.text == "café façade"


def test_it_stops_when_the_person_starts_working_in_that_window(keyboard, monkeypatch):
    """Withheld in the same breath, so calling again cannot win the race."""
    def yielded(progress, element_id, window, client_id):
        if len(keyboard.text) < 4:
            return False
        progress["yieldedTo"] = "user"
        progress["stoppedBecause"] = "the person at this desktop started working in that window"
        return True

    monkeypatch.setattr(server, "_yielded", yielded)
    result = type_keystrokes(text="a message they interrupted")

    assert result["ok"] is False
    assert result["progress"]["yieldedTo"] == "user"
    assert keyboard.text == "a me"


def test_it_goes_through_the_same_claim_registry_as_every_other_write(keyboard):
    """A field another client is holding is refused here too.

    The registry is the seam that makes two writers safe, and a write channel
    that skipped it would be a hole in the middle of it. This method joins by
    being classed as an edit rather than by remembering to opt in.
    """
    assert "typeKeystrokes" in holds.WRITE_METHODS

    holds.claim("el-a", "someone-else", lease_ms=30_000)
    try:
        with pytest.raises(errors.ElementHeld):
            type_keystrokes(text="not yours")
        assert keyboard.text == ""
    finally:
        holds.release("el-a", holder_id="someone-else")
