"""This service is reachable from the internet and can reach no machine.

Everything else in this repository is careful about what an agent may do to a
desktop. This package is the first thing that will sit on a public address, and
the property that makes that acceptable is structural rather than careful: there
is no path from here to any daemon. Not a socket it opens, not a module it
imports, not a verb that names a session.

The transport's own docstring already draws the line — *nothing network-facing
ever speaks to the desktop directly* — and this file is where that stops being a
sentence in a comment. An import added in a hurry, six months from now, fails
here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parent.parent / "commons_service"


def _modules() -> list[Path]:
    return sorted(PACKAGE.glob("*.py"))


def _imported(source: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(source.read_text())):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module)
    return names


def test_the_scan_above_is_scanning_something():
    """The guard on the guards.

    Every assertion in this file is parametrized over a glob, and a glob that
    matches nothing makes every one of them pass by running none of them. A
    renamed directory would turn this file green and silent on the same day it
    stopped checking anything, which is worse than not having written it. So the
    modules it expects to find are named here, and it fails if they are not
    there to be read.
    """
    found = {module.name for module in _modules()}

    assert {
        "__init__.py",
        "__main__.py",
        "publishing.py",
        "server.py",
        "submission.py",
    } <= found


@pytest.mark.parametrize("module", _modules(), ids=lambda path: path.name)
def test_no_module_here_imports_the_desktop_service(module: Path):
    for imported in _imported(module):
        assert not imported.startswith("desktop_service"), (
            f"{module.name} imports {imported}: a service holding a public"
            " credential that could also reach a desktop is one machine away"
            " from being the way in"
        )


@pytest.mark.parametrize("module", _modules(), ids=lambda path: path.name)
def test_no_module_here_starts_a_process_or_opens_a_socket_of_its_own(module: Path):
    """The forge runs `git` and `gh`; this package runs nothing and dials nobody.

    Subprocesses are `skill_commons.forge`'s business, and what they reach is a
    repository. One started here would be one reached straight from a request
    body. `socket` is the other half: the daemon's transport is a Unix socket at
    a known path, and the module that could open one is the module that could be
    pointed at it.
    """
    for imported in _imported(module):
        assert imported not in {"subprocess", "socket"}, (
            f"{module.name} imports {imported}"
        )


def test_the_only_thing_this_reads_from_the_environment_is_whether_it_may_post():
    """One variable, read as set-or-not, never for its contents.

    A service that read a machine's environment for anything else would be a
    service whose behaviour depends on where it was started, which is the thing
    a deployment cannot reason about.

    Read from the parsed module rather than from its text. A count of a string in
    a source file counts it in the comments and the docstrings too — including
    this one — so a paragraph explaining the rule would break the test that
    enforces it, and the usual repair for that is to loosen the test.
    """
    from commons_service import publishing

    read: list[ast.Call] = []
    for node in ast.walk(ast.parse((PACKAGE / "publishing.py").read_text())):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if not isinstance(function, ast.Attribute) or function.attr != "get":
            continue
        of = function.value
        named = of.attr if isinstance(of, ast.Attribute) else getattr(of, "id", "")
        if named == "environ":
            read.append(node)

    assert len(read) == 1
    asked_for = read[0].args[0]
    assert isinstance(asked_for, ast.Name) and asked_for.id == "TOKEN_ENV"

    assert publishing.TOKEN_ENV == "COMMONS_GITHUB_TOKEN"
    assert publishing.publish_disabled({publishing.TOKEN_ENV: "x"}) == ""
    assert publishing.publish_disabled({}) != ""
