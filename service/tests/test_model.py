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


def test_the_constructor_applies_the_policy_to_name_and_value():
    """No construction site can opt out, because the door is inside the door frame."""
    model.set_value_policy(lambda ctx: f"<{ctx.field}>")
    element = model.SemanticElement(
        id="el-000000000000", backend="atspi", role="entry", name="Password", value="hunter2"
    )
    assert element.name == "<name>"
    assert element.value == "<value>"
    assert "hunter2" not in repr(element.to_json())


def test_positional_construction_cannot_smuggle_text_past_the_policy():
    """The bypass a keyword-only check would have missed."""
    model.set_value_policy(lambda ctx: "***")
    element = model.SemanticElement("el-000000000000", "atspi", "entry", "Password", "hunter2")
    assert element.name == "***"
    assert element.value == "***"


def test_backend_surplus_leaves_by_the_same_door():
    """`extra` is text a backend chose not to flatten — not text exempt from policy."""
    model.set_value_policy(lambda ctx: "***" if ctx.field == model.EXTRA else ctx.text)
    element = model.SemanticElement(
        id="el-000000000000",
        backend="atspi",
        role="entry",
        extra={"atspi": {"tooltip": "hunter2", "nested": ["hunter2"], "index": 3}},
    )
    payload = element.to_json()
    assert payload["extra"]["atspi"]["tooltip"] == "***"
    assert payload["extra"]["atspi"]["nested"] == ["***"]
    # Non-text is left alone: a policy is for text, and mangling an integer
    # would corrupt data while protecting nothing.
    assert payload["extra"]["atspi"]["index"] == 3
    assert "hunter2" not in repr(payload)


def test_no_backend_emits_element_text_outside_a_semantic_element():
    """The structural half: reading the code rather than trusting the paths tested.

    The constructor guarantees that anything built as a `SemanticElement` is
    clean. This fails if a backend gains a *second* way to emit element text —
    a hand-rolled dict with a name or value key — which is exactly how a
    redaction hole gets introduced a segment from now.
    """
    backends = Path(__file__).resolve().parents[1] / "desktop_service" / "backends"
    text_keys = {model.NAME, model.VALUE, model.TITLE, model.APPLICATION_NAME}
    # rglob, not glob: a backend package added under this directory is still a
    # backend, and a top-level-only check would not look at it.
    for path in backends.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Dict):
                continue
            keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
            for key, value in zip(node.keys, node.values):
                if not isinstance(key, ast.Constant) or key.value not in text_keys:
                    continue
                # A bare "name" is only user text when the dict identifies
                # something on the desktop. {"name": "GTK", "version": ...}
                # describes a toolkit, and redacting that protects nobody.
                if key.value == model.NAME and "id" not in keys:
                    continue
                assert _is_egress_call(value), (
                    f"{path.name}:{node.lineno}: {key.value!r} is being put into a "
                    "hand-built dict without passing model.egress_value — every "
                    "piece of human-readable text leaves by the one door"
                )
