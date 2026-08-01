"""The value-egress point is the only way text leaves a backend.

This is the property a later segment's redaction guarantee rests on, so it is
tested now — before the delta and signal payloads that must also honour it are
written. A test that only checked `egress_value` in isolation would prove
nothing; what matters is that the *backend* has no other path out.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from desktop_service import model


@pytest.fixture(autouse=True)
def restore_policy():
    previous = model.get_value_policy()
    yield
    model.set_value_policy(previous)


def test_default_policy_passes_text_through():
    assert model.egress_value("Save", field=model.NAME) == "Save"


def test_absent_text_never_reaches_the_policy():
    seen = []
    model.set_value_policy(lambda ctx: seen.append(ctx) or ctx.text)
    assert model.egress_value(None, field=model.VALUE) == ""
    assert model.egress_value("", field=model.VALUE) == ""
    assert seen == []


def test_policy_receives_the_context_a_redaction_decision_needs():
    captured = {}

    def policy(ctx):
        captured.update(
            {"field": ctx.field, "role": ctx.role, "states": ctx.states, "text": ctx.text}
        )
        return "***"

    model.set_value_policy(policy)
    out = model.egress_value(
        "hunter2", field=model.VALUE, role="password text", states=["focused"]
    )
    assert out == "***"
    assert captured["role"] == "password text"
    assert captured["states"] == ("focused",)


def test_set_value_policy_returns_the_previous_policy():
    first = model.get_value_policy()
    returned = model.set_value_policy(lambda ctx: "x")
    assert returned is first
    assert model.set_value_policy(None) is not first
    assert model.get_value_policy() is model._passthrough


def _semantic_element_constructions(source: str) -> list[ast.Call]:
    tree = ast.parse(source)
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "SemanticElement"
    ]


def _is_egress_call(node) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "egress_value"
    )


def test_no_backend_builds_an_element_whose_text_skipped_the_egress_point():
    """The structural guarantee, checked by reading the code rather than trusting it.

    A behavioural test can only prove that the paths it happens to exercise are
    clean. This one fails the moment *any* backend gains a second construction
    site that assigns a name or value from something other than `egress_value` —
    which is exactly how a redaction hole gets introduced a segment from now.
    """
    backends = Path(__file__).resolve().parents[1] / "desktop_service" / "backends"
    checked = 0
    for path in backends.glob("*.py"):
        for call in _semantic_element_constructions(path.read_text()):
            checked += 1
            for keyword in call.keywords:
                if keyword.arg in {"name", "value"}:
                    assert _is_egress_call(keyword.value), (
                        f"{path.name}: SemanticElement({keyword.arg}=...) bypasses "
                        "model.egress_value — every value leaving a backend must "
                        "pass the egress point"
                    )
    assert checked > 0, "found no SemanticElement construction to check"
