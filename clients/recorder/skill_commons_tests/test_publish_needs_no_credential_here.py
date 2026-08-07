"""Contributing costs the person nothing they have to go and get first.

The forge in this package reaches the commons the way a maintainer does: a
checkout, `git`, `gh`, and whatever token is installed on the machine. That is
the right shape for the machine that maintains the repository and the wrong
shape for everybody else, because it puts a GitHub account, a personal access
token and a working `git` between somebody's desktop and the collective — and
most of the people whose machines will learn the most interesting routes have
none of the three.

So the user-side publish path speaks to the project's own service instead, and
these tests are about what that path does *not* touch. They are written as
absences because absences are what can be proved: no subprocess, no token read,
no `Authorization` header, no field on the client to put one in. The credential
lives on the service, which is also where the screens run again — a gate that
only ran on the contributor's machine is a gate a modified client walks past.
"""

from __future__ import annotations

import io
import json
import tokenize
from pathlib import Path

import pytest

from skill_commons import HttpService, Publisher
from skill_commons import publish as publish_module
from skill_commons import outbound as outbound_module

from skill_commons_tests.conftest import FakeTransport

#: Every name a program reaches for when it wants to act as somebody on GitHub.
CREDENTIAL_ENV = (
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_USER",
    "GH_CONFIG_DIR",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
)

#: A token-shaped string. If it ever comes out of this machine, it came out of
#: the environment, and that is the failure this file is here to catch.
SENTINEL = "ghp-000000000000000000000000000000000000"


@pytest.fixture
def bare(monkeypatch, tmp_path: Path):
    """A machine with no git identity, no gh config, and a poisoned env.

    The token is *present* rather than absent, because "it worked without a
    token" and "it did not touch the token" are different claims and only the
    second one is worth having.
    """
    for name in CREDENTIAL_ENV:
        monkeypatch.setenv(name, SENTINEL)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path))
    return tmp_path


def test_a_skill_publishes_from_a_machine_with_no_git_and_no_account(
    bare, service, route
):
    """The whole verb, on a desktop that has never heard of a pull request."""
    publisher = Publisher(service)

    receipt = publisher.publish(publisher.preview(route))

    assert receipt.accepted
    assert receipt.where


def test_publishing_runs_no_program(bare, monkeypatch, service, route):
    """No `git`, no `gh`, nothing. `PATH` is empty above; this says why.

    A subprocess is how the local-credential approach gets back in — one call
    to `gh` and the person needs an account again — so the whole module is held
    to launching none.
    """
    import subprocess

    def refuse(*args, **kwargs):
        raise AssertionError(f"the publish path ran a program: {args!r}")

    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(subprocess, "check_output", refuse)

    publisher = Publisher(service)
    assert publisher.publish(publisher.preview(route)).accepted


def test_the_request_carries_no_credential_and_no_header_to_put_one_in(route):
    """What goes on the wire, read off the request that was built."""
    transport = FakeTransport(
        body=json.dumps({"where": "https://github.com/owner/repo/pull/4"})
    )
    publisher = Publisher(HttpService("https://commons.example/skills", transport))

    receipt = publisher.publish(publisher.preview(route))

    sent = transport.last
    assert receipt.accepted
    assert "authorization" not in {key.lower() for key in sent.headers}
    assert "cookie" not in {key.lower() for key in sent.headers}
    assert SENTINEL not in sent.data.decode()


def test_the_service_client_has_nowhere_to_hold_a_credential():
    """Not "does not send one" — cannot be given one.

    A field that could be filled in from the environment eventually is, by a
    well-meaning change six months from now. There is no field.
    """
    assert set(HttpService.__dataclass_fields__) == {
        "endpoint",
        "transport",
        "timeout",
    }


def test_the_publish_path_does_not_speak_of_forges_at_all():
    """Read off the source, because this is a claim about what is not written.

    The two modules a publish goes through are held to naming no credential, no
    version control program and no forge. An import that appeared here would be
    the first step back towards every contributor needing an account.
    """
    for module in (publish_module, outbound_module):
        code = _code_of(module)
        for forbidden in ("subprocess", "getenv", "environ", "forge", "gh", "git"):
            assert forbidden not in code.split(), (
                f"{module.__name__} names {forbidden}"
            )


def test_a_service_that_cannot_be_reached_is_told_about_not_guessed_at(route):
    """Unreachable is not success, and it is not silence either.

    A button that quietly did nothing is a button pressed four times, and four
    presses against a service that comes back up is four proposals for one
    skill.
    """
    transport = FakeTransport()
    transport.raise_with = OSError("no route to host")
    publisher = Publisher(HttpService("https://commons.example/skills", transport))

    receipt = publisher.publish(publisher.preview(route))

    assert not receipt.accepted
    assert "could not be reached" in receipt.reason
    assert not receipt.where


def test_a_refusal_from_the_service_keeps_its_reason(route):
    transport = FakeTransport(
        status=422,
        body=json.dumps({"reason": "the review screen refused: a link"}),
    )
    publisher = Publisher(HttpService("https://commons.example/skills", transport))

    receipt = publisher.publish(publisher.preview(route))

    assert not receipt.accepted
    assert receipt.reason == "the review screen refused: a link"


def _code_of(module) -> str:
    """A module with its prose taken out, by the tokenizer rather than by eye.

    These modules explain at length what they deliberately do not do, and a
    check that could not tell the explanation from the act would forbid the
    explanation. Strings and comments go; what is left is what runs.
    """
    source = Path(module.__file__).read_text()
    kept = [
        token.string
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type not in (tokenize.COMMENT, tokenize.STRING)
    ]
    return " ".join(kept)
