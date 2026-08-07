"""Rediscovery's refusal to guess.

The protocol's rule is that the service never acts on a different element because
it resembles the one the caller referenced. Rediscovery is the one place that
rule could be broken quietly, so the ambiguous case is tested directly rather
than left to inspection of the branch.
"""

from __future__ import annotations

import pytest

from desktop_service.backends import atspi
from desktop_service.registry import Fingerprint


class FakeAccessible:
    """Enough of an accessible for the search to walk it."""

    def __init__(self, role, name, index=0, children=()):
        self._role = role
        self._name = name
        self._index = index
        self._children = list(children)

    def get_role_name(self):
        return self._role

    def get_name(self):
        return self._name

    def get_index_in_parent(self):
        return self._index

    def get_parent(self):
        return None

    def get_child_count(self):
        return len(self._children)

    def get_child_at_index(self, index):
        return self._children[index]


@pytest.fixture
def desktop(monkeypatch):
    """A one-application desktop whose window contents the test decides."""

    def install(children):
        window = FakeAccessible("frame", "Window", 0, children)
        app = FakeAccessible("application", "FakeApp", 0, [window])
        monkeypatch.setattr(atspi, "_iter_desktop_apps", lambda: [app])
        monkeypatch.setattr(atspi, "_bus_name", lambda obj: ":1.99")
        monkeypatch.setattr(atspi, "_windows_of", lambda a: [window])
        return window

    return install


REFERENCE = {"busName": ":1.99", "path": "/org/a11y/atspi/accessible/7"}


def test_two_identical_candidates_produce_no_answer(desktop):
    desktop(
        [
            FakeAccessible("push button", "Delete", 0),
            FakeAccessible("push button", "Delete", 1),
        ]
    )
    found = atspi.rediscover(Fingerprint("push button", "Delete", 0), REFERENCE)
    assert found is None, "an ambiguous match must not be resolved by picking one"


def test_a_single_candidate_is_returned_and_resolves(desktop):
    desktop(
        [
            FakeAccessible("push button", "Delete", 0),
            FakeAccessible("push button", "Save", 1),
        ]
    )
    found = atspi.rediscover(Fingerprint("push button", "Delete", 3), REFERENCE)
    assert found is not None
    new_id, reference, fingerprint = found
    assert fingerprint.name == "Delete"
    assert reference["busName"] == ":1.99"
    assert atspi.fingerprint_of({"id": new_id}) is not None
    atspi._objects.pop(new_id, None)


def test_a_different_application_is_never_searched(desktop):
    desktop([FakeAccessible("push button", "Delete", 0)])
    other_app = {"busName": ":1.5", "path": "/org/a11y/atspi/accessible/7"}
    assert atspi.rediscover(Fingerprint("push button", "Delete", 0), other_app) is None


def test_a_name_change_is_not_a_match(desktop):
    """Rediscovery matches on identity, not on position.

    A button that kept its slot but changed its label is a different element as
    far as the caller is concerned, and the stale error says so.
    """
    desktop([FakeAccessible("push button", "Discard", 0)])
    assert atspi.rediscover(Fingerprint("push button", "Delete", 0), REFERENCE) is None


def test_the_production_registry_actually_has_a_rediscoverer():
    """The protocol documents re-resolution as a feature.

    A registry built without a rediscoverer answers every stale reference with a
    null newElementId and no error anywhere — the promise would simply never be
    kept. This asserts the wiring, not the behaviour, because the behaviour is
    only reachable if the wiring exists.
    """
    from desktop_service import server

    assert server._registry._rediscoverer is not None
    assert server._registry._rediscoverer is atspi.rediscover
