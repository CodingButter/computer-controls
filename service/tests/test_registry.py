"""The registry's contract: an id never resolves to a different element."""

from __future__ import annotations

import pytest

from desktop_service.errors import ErrorCode
from desktop_service.registry import (
    ElementNotFound,
    ElementReferenceStale,
    ElementRegistry,
    Fingerprint,
)


def fp(role="push button", name="Save", index=0, parent="root") -> Fingerprint:
    return Fingerprint(role=role, name=name, index=index, parent=parent)


def obs(element_id="el-1", fingerprint=None, path="/a"):
    return (element_id, "atspi", {"id": element_id, "path": path}, fingerprint or fp())


def test_identical_fingerprints_are_stable_and_do_not_advance_the_revision():
    registry = ElementRegistry()
    first = registry.record([obs()])
    second = registry.record([obs()])
    assert first == second == 1


def test_revision_advances_once_per_changed_observation_not_once_per_element():
    registry = ElementRegistry()
    batch = [obs(f"el-{i}", fp(name=f"Button {i}")) for i in range(10)]
    assert registry.record(batch) == 1

    changed = [obs("el-3", fp(name="Renamed")), *batch[4:]]
    assert registry.record(changed) == 2


def test_unknown_id_is_not_found_rather_than_stale():
    registry = ElementRegistry()
    with pytest.raises(ElementNotFound) as excinfo:
        registry.get("el-missing")
    assert excinfo.value.code == ErrorCode.ELEMENT_NOT_FOUND


def test_a_changed_element_raises_stale_and_names_what_changed():
    current = fp()
    registry = ElementRegistry(prober=lambda _ref: current)
    registry.record([obs()])
    assert registry.resolve("el-1").element_id == "el-1"

    current = fp(role="toggle button", index=2)
    with pytest.raises(ElementReferenceStale) as excinfo:
        registry.resolve("el-1")

    detail = excinfo.value.detail
    assert excinfo.value.code == ErrorCode.ELEMENT_REFERENCE_STALE
    assert detail["elementId"] == "el-1"
    assert detail["observedAtRevision"] == 1
    assert detail["currentRevision"] >= 1
    assert detail["changed"]["role"] == ["push button", "toggle button"]
    assert detail["changed"]["index"] == ["0", "2"]


def test_a_vanished_element_is_stale_with_no_field_diff():
    registry = ElementRegistry(prober=lambda _ref: None)
    registry.record([obs()])
    with pytest.raises(ElementReferenceStale) as excinfo:
        registry.resolve("el-1")
    assert excinfo.value.detail["changed"] == {}
    assert "no longer exists" in excinfo.value.message


def test_stale_reference_is_never_substituted_with_a_similar_element():
    """The whole reason this module exists.

    Two buttons differ only by their position in the list. When the first goes
    away, resolving its id must not quietly hand back the second.
    """
    survivor = fp(name="Delete", index=1)
    registry = ElementRegistry(prober=lambda _ref: None)
    registry.record([obs("el-first", fp(name="Delete", index=0))])
    registry.record([obs("el-second", survivor)])

    with pytest.raises(ElementReferenceStale):
        registry.resolve("el-first")


def test_re_resolution_offers_a_new_id_and_never_reuses_the_old_one():
    replacement_fp = fp(name="Save", index=0, parent="reopened")

    def rediscover(_old_fp, _ref):
        return ("el-2", {"id": "el-2", "path": "/b"}, replacement_fp)

    registry = ElementRegistry(prober=lambda _ref: None, rediscoverer=rediscover)
    registry.record([obs()])

    with pytest.raises(ElementReferenceStale) as excinfo:
        registry.resolve("el-1")

    assert excinfo.value.detail["newElementId"] == "el-2"
    # The replacement is registered, so re-acquiring costs one call, not a
    # whole re-inspection.
    assert registry.get("el-2").fingerprint == replacement_fp


def test_rediscovery_never_points_a_stale_id_at_itself():
    """A stale id offered as its own replacement would loop the caller forever."""

    def rediscover(old_fp, ref):
        return ("el-1", ref, old_fp)

    registry = ElementRegistry(prober=lambda _ref: None, rediscoverer=rediscover)
    registry.record([obs()])

    with pytest.raises(ElementReferenceStale) as excinfo:
        registry.resolve("el-1")
    assert "newElementId" not in excinfo.value.detail


def test_a_failing_rediscoverer_still_produces_a_clean_stale_error():
    def rediscover(_old_fp, _ref):
        raise RuntimeError("the application exited mid-search")

    registry = ElementRegistry(prober=lambda _ref: None, rediscoverer=rediscover)
    registry.record([obs()])

    with pytest.raises(ElementReferenceStale) as excinfo:
        registry.resolve("el-1")
    assert "newElementId" not in excinfo.value.detail
