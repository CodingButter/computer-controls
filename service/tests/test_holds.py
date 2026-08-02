"""Ownership of an element while it is being written.

The registry on its own, without an action or a desktop around it. What matters
here is that a refusal names the holder — a caller told only "no" has to guess
whether to wait, retry or give up — and that ownership is exactly as wide as one
element and no wider.
"""

from __future__ import annotations

import time

import pytest

from desktop_service import cadence, errors, holds, identity


@pytest.fixture(autouse=True)
def clean_registry():
    yield
    for element_id in list(holds._holds):
        holds.release(element_id)
    holds._expired.clear()


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


# --- claims: ownership that spans calls, bounded by the work it was taken for


def test_a_claim_is_held_by_the_client_that_took_it() -> None:
    hold = holds.claim("el-a", "cl-one", lease_ms=5_000, reason="answering Caleb")

    assert hold.claimed
    assert hold.reason == "answering Caleb"
    assert 0 < hold.expires_in_ms() <= 5_000
    assert holds.holder("el-a").client_id == "cl-one"


def test_a_claimed_element_cannot_be_claimed_by_anybody_else() -> None:
    """Jamie's rule: claimed is claimed until it is given back."""
    with identity.bound("cl-one", "the drafting agent"):
        holds.claim("el-a", "cl-one", lease_ms=5_000)

    with pytest.raises(errors.ElementHeld) as refusal:
        holds.claim("el-a", "cl-two", lease_ms=5_000)

    assert refusal.value.detail["heldBy"] == "cl-one"
    assert refusal.value.detail["heldByLabel"] == "the drafting agent"


def test_a_claimed_element_refuses_another_clients_write_too() -> None:
    """A claim that only stopped other claims would stop nothing that matters."""
    holds.claim("el-a", "cl-one", lease_ms=5_000)

    with pytest.raises(errors.ElementHeld):
        with holds.for_write("typeText", "el-a", "cl-two"):
            pass


def test_a_write_inside_your_own_claim_is_let_through_and_keeps_the_claim() -> None:
    """The point of claiming: read, decide, write, write again — one piece of work."""
    holds.claim("el-a", "cl-one", lease_ms=5_000)

    with holds.for_write("typeText", "el-a", "cl-one") as hold:
        assert hold.claimed

    still_mine = holds.holder("el-a")
    assert still_mine is not None and still_mine.claimed
    assert still_mine.method == "claimElement"


def test_an_unclaimed_write_still_owns_the_element_only_for_its_own_length() -> None:
    """The rule holds for callers that never heard of claiming."""
    with holds.for_write("typeText", "el-a", "cl-one") as hold:
        assert hold is not None and not hold.claimed
        assert holds.holder("el-a").client_id == "cl-one"

    assert holds.holder("el-a") is None


def test_a_lease_that_runs_out_frees_the_element() -> None:
    holds.claim("el-a", "cl-one", lease_ms=1)
    time.sleep(0.005)

    assert holds.holder("el-a") is None
    holds.claim("el-a", "cl-two", lease_ms=5_000)
    assert holds.holder("el-a").client_id == "cl-two"


def test_the_client_whose_claim_ran_out_is_told_once() -> None:
    """A bad estimate is a report, not a mystery — and not a stream of them."""
    holds.claim("el-a", "cl-one", lease_ms=1)
    time.sleep(0.005)
    assert holds.holder("el-a") is None  # noticed on the way past

    with pytest.raises(errors.ClaimExpired) as lapse:
        with holds.for_write("typeText", "el-a", "cl-one"):
            pass
    assert lapse.value.code == errors.ErrorCode.CLAIM_EXPIRED

    with holds.for_write("typeText", "el-a", "cl-one") as hold:
        assert hold is not None and not hold.claimed


def test_re_claiming_your_own_element_extends_it_rather_than_refusing_you() -> None:
    holds.claim("el-a", "cl-one", lease_ms=60)
    time.sleep(0.03)
    extended = holds.claim("el-a", "cl-one", lease_ms=5_000)

    assert extended.expires_in_ms() > 1_000


def test_a_disconnecting_client_gives_its_claims_back() -> None:
    holds.claim("el-a", "cl-one", lease_ms=600_000)

    assert holds.release_all("cl-one") == ["el-a"]
    assert holds.holder("el-a") is None


def test_a_lease_is_sized_from_the_text_when_one_is_given() -> None:
    """So the estimate and the work cannot drift apart."""
    sentence = "the quick brown fox jumps over the lazy dog" * 4
    typing_ms = cadence.estimate_ms(sentence, cadence.DEFAULT_WPM)

    lease = holds.lease_for(for_text=sentence)

    assert lease == typing_ms + holds.CLAIM_MARGIN_MS
    assert lease > holds.lease_for(for_text="hi")


def test_a_lease_nobody_can_outlive_is_refused_by_the_ceiling() -> None:
    assert holds.lease_for(10_000_000) == holds.MAX_LEASE_MS


def test_a_caller_that_says_nothing_about_the_work_gets_the_default() -> None:
    assert holds.lease_for() == holds.DEFAULT_LEASE_MS
