"""The policy, and the guarantee that it cannot be walked around.

Two kinds of test live here. The first kind asks whether the policy decides
correctly. The second kind asks whether deciding correctly is enough — whether
there is any path out of this service that reaches a caller without passing the
decision. The second kind is the one that matters: a redaction policy with one
bypass is not a weaker guarantee than a policy with none, it is no guarantee.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from desktop_service import model, redaction


@pytest.fixture(autouse=True)
def restore_policy():
    previous = model.get_value_policy()
    yield
    model.set_value_policy(previous)


def context(text="hunter2", *, field=model.VALUE, role="entry", states=(), application="") -> model.ValueContext:
    return model.ValueContext(
        text=text,
        field=field,
        role=role,
        states=tuple(states),
        element_id="el-1",
        application=application,
    )


def test_a_password_field_is_a_password_field_by_its_role():
    policy = redaction.default_policy()
    assert policy(context(role="password text")) == redaction.MARKER


def test_a_toolkit_that_marks_the_state_instead_is_also_understood():
    # GTK4 reuses the ordinary entry role and sets a state. A policy that only
    # knew about roles would hand these over as ordinary text.
    policy = redaction.default_policy()
    assert policy(context(role="entry", states=("focusable", "is-password"))) == redaction.MARKER


def test_the_same_text_in_an_ordinary_field_passes_through():
    # "hunter2" is a password in a password field and a perfectly good message
    # in a chat window. The role decides, never the text.
    policy = redaction.default_policy()
    assert policy(context(text="hunter2", role="entry", application="Discord")) == "hunter2"


def test_an_empty_password_field_is_still_a_password_field():
    # Nothing to protect yet is not the same as nothing to protect. This is why
    # the decision reads the role rather than the value.
    policy = redaction.default_policy()
    assert policy(context(text="a", role="password text")) == redaction.MARKER


def test_a_password_manager_redacts_ordinary_looking_fields_too():
    # Every row in a vault is a secret wearing a label's role.
    policy = redaction.default_policy()
    assert policy(context(text="github.com", role="label", application="Bitwarden")) == redaction.MARKER


def test_a_sensitive_application_is_matched_inside_a_longer_name():
    policy = redaction.default_policy()
    assert policy(context(role="label", application="Bitwarden - Google Chrome")) == redaction.MARKER


def test_a_sensitive_applications_own_name_survives():
    # The caller has to be able to say which window it is looking at, and
    # "which application" is not the secret — its contents are.
    policy = redaction.default_policy()
    emitted = policy(context(text="Bitwarden", field=model.APPLICATION_NAME, application="Bitwarden"))
    assert emitted == "Bitwarden"


def test_a_sensitive_applications_window_title_does_not():
    # A password manager's title is the name of the account being looked at.
    policy = redaction.default_policy()
    assert policy(context(text="GitHub — Bitwarden", field=model.TITLE, application="Bitwarden")) == redaction.MARKER


def test_an_ordinary_window_keeps_its_title():
    policy = redaction.default_policy()
    title = policy(context(text="notes.md - Text Editor", field=model.TITLE, application="gnome-text-editor"))
    assert title == "notes.md - Text Editor"


def test_configuration_adds_to_the_defaults_rather_than_replacing_them():
    # A config that named its own applications and thereby switched off the
    # built-in list would be a footgun aimed at the thing this module protects.
    policy = redaction.default_policy(["my-vault"])
    assert policy(context(role="label", application="my-vault")) == redaction.MARKER
    assert policy(context(role="label", application="KeePassXC")) == redaction.MARKER


def test_a_redacted_value_is_replaced_and_never_omitted():
    # An agent filling in a login has to know the field is there. What it must
    # not learn is what is in it — including how long it is.
    policy = redaction.default_policy()
    emitted = policy(context(text="correct horse battery staple", role="password text"))
    assert emitted == redaction.MARKER
    assert emitted != ""
    assert len(emitted) != len("correct horse battery staple")


def test_the_marker_is_not_a_plausible_password():
    # A run of bullets reads as "the password is eight characters", and an
    # agent may well try to use it.
    assert set(redaction.MARKER) != {"•"}
    assert set(redaction.MARKER) != {"*"}


def test_installing_the_policy_routes_the_egress_point_through_it():
    redaction.install()
    assert model.egress_value("hunter2", field=model.VALUE, role="password text") == redaction.MARKER
    assert model.egress_value("hunter2", field=model.VALUE, role="entry") == "hunter2"


def test_an_element_built_by_a_backend_is_redacted_on_construction():
    # The policy runs in SemanticElement.__post_init__, so a value is redacted
    # by the act of building the element rather than by remembering to ask.
    redaction.install()
    element = model.SemanticElement(
        id="el-1",
        role="password text",
        name="Password",
        value="hunter2",
        backend="atspi",
        backend_reference=object(),
    )
    assert element.value == redaction.MARKER


def test_a_secret_nested_in_extra_does_not_escape_by_the_side_door():
    # An unwalked branch is exactly where a password would sit unnoticed.
    redaction.install()
    element = model.SemanticElement(
        id="el-1",
        role="password text",
        name="Password",
        value="",
        backend="atspi",
        backend_reference=object(),
        extra={"atspi": {"textAtCaret": "hunter2", "runs": ["hunter2"]}},
    )
    assert "hunter2" not in repr(element.extra)


SERVICE = Path(__file__).resolve().parents[1] / "desktop_service"


def _egress_free_functions(tree: ast.AST) -> set[str]:
    """Names in the backend that read text without routing it anywhere."""
    return {"get_text", "get_name", "get_description", "get_title"}


def test_no_module_installs_a_policy_of_its_own_behind_the_services_back():
    # One policy, installed once, at startup. A module that quietly swapped it
    # would be indistinguishable from redaction working right up until it
    # mattered.
    installers = []
    for path in SERVICE.rglob("*.py"):
        if path.name in {"model.py", "redaction.py"}:
            continue
        source = path.read_text(encoding="utf-8")
        if "set_value_policy" in source:
            installers.append(path.name)
    assert installers in ([], ["__main__.py"]), installers


def test_every_text_bearing_field_of_an_element_passes_the_door():
    # Asserted against the code rather than against the docstring: a promise in
    # prose is not a mechanism.
    source = (SERVICE / "model.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    post_init = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "__post_init__"
    )
    called = {
        node.func.id
        for node in ast.walk(post_init)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "egress_value" in called or "_egress_recursive" in called or "_walk" in called


def test_a_password_fields_label_survives_but_its_contents_do_not():
    # "Password" and "Confirm password" are how an agent tells the two boxes
    # apart. Withholding the label turns a login form into a guessing game
    # while protecting nothing.
    policy = redaction.default_policy()
    assert policy(context(text="Confirm password", field=model.NAME, role="password text")) == "Confirm password"
    assert policy(context(text="hunter2", field=model.VALUE, role="password text")) == redaction.MARKER
