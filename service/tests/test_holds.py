"""Ownership of an element while it is being written.

The registry on its own, without an action or a desktop around it. What matters
here is that a refusal names the holder — a caller told only "no" has to guess
whether to wait, retry or give up — and that ownership is exactly as wide as one
element and no wider.
"""

from __future__ import annotations

import pytest

from desktop_service import errors, holds, identity


@pytest.fixture(autouse=True)
def clean_registry():
    yield
    for element_id in list(holds._holds):
        holds.release(element_id)


def test_an_element_nobody_is_writing_has_no_holder() -> None:
    assert holds.holder("el-a") is None


def test_a_hold_is_taken_and_given_back() -> None:
    holds.acquire("el-a", "cl-one", "typeText")
    assert holds.holder("el-a").client_id == "cl-one"

    released = holds.release("el-a", holder_id="cl-one")
    assert released is not None
    assert holds.holder("el-a") is None


def test_a_second_writer_is_refused_and_told_who_holds_it() -> None:
    """The whole point: the refusal has to be actionable."""
    with identity.bound("cl-one", "the drafting agent"):
        holds.acquire("el-a", "cl-one", "typeText")

    with pytest.raises(errors.ElementHeld) as refusal:
        holds.acquire("el-a", "cl-two", "editText")

    assert refusal.value.code == errors.ErrorCode.ELEMENT_HELD
    assert refusal.value.detail["heldBy"] == "cl-one"
    assert refusal.value.detail["heldByLabel"] == "the drafting agent"
    assert refusal.value.detail["heldMethod"] == "typeText"
    assert refusal.value.detail["heldForMs"] >= 0
    assert "the drafting agent" in refusal.value.message


def test_two_elements_are_owned_independently() -> None:
    """Two workers in one application is the case that has to keep working."""
    holds.acquire("el-a", "cl-one", "typeText")
    holds.acquire("el-b", "cl-two", "typeText")

    assert holds.holder("el-a").client_id == "cl-one"
    assert holds.holder("el-b").client_id == "cl-two"


def test_a_release_by_the_wrong_client_leaves_the_hold_alone() -> None:
    """A preempted writer finishing must not free the element from its successor."""
    holds.acquire("el-a", "cl-one", "typeText")

    assert holds.release("el-a", holder_id="cl-two") is None
    assert holds.holder("el-a").client_id == "cl-one"


def test_an_unfiltered_release_takes_the_element_from_whoever_has_it() -> None:
    """The seam preemption needs: the taker does not hold the hold it is ending."""
    holds.acquire("el-a", "cl-one", "typeText")

    assert holds.release("el-a").client_id == "cl-one"
    assert holds.holder("el-a") is None


def test_releasing_everything_a_client_held_leaves_other_clients_alone() -> None:
    holds.acquire("el-a", "cl-one", "typeText")
    holds.acquire("el-b", "cl-one", "editText")
    holds.acquire("el-c", "cl-two", "typeText")

    assert sorted(holds.release_all("cl-one")) == ["el-a", "el-b"]
    assert holds.holder("el-a") is None
    assert holds.holder("el-c").client_id == "cl-two"


def test_the_owned_methods_are_the_ones_that_write_text() -> None:
    """Derived from the protocol, so a later edit method arrives owned."""
    assert holds.WRITE_METHODS == {"typeText", "editText", "setElementValue"}


def test_a_method_that_does_not_write_takes_no_hold() -> None:
    with holds.for_write("focusWindow", "win-a", "cl-one") as hold:
        assert hold is None
        assert holds.holder("win-a") is None


def test_the_write_context_gives_the_element_back_even_when_the_write_raises() -> None:
    with pytest.raises(RuntimeError):
        with holds.for_write("typeText", "el-a", "cl-one"):
            assert holds.holder("el-a") is not None
            raise RuntimeError("the toolkit fell over")

    assert holds.holder("el-a") is None
