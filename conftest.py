"""Which tests need a desktop, decided by the machine rather than by a habit.

Most of this suite is arithmetic: a protocol, a registry, a delta engine, a
consent ceiling. None of it has ever seen a window. A smaller set drives a real
session — it opens applications, reads their accessibility trees and takes
pictures of them — and those tests exist precisely because a desktop is the
thing that lies. They cannot be simulated without simulating away the answer.

Until now the difference lived in the file names and in whoever remembered to
pass nine `--ignore` flags. That is a convention, and a convention is not a
gate: a run on a machine with no display would fail loudly and look like a
regression. So the split is declared here instead — every test whose module
ends in `_live` carries the `live` marker, and a session that cannot offer a
desktop deselects them and says which one was missing.

Nothing here is skipped for convenience. `--live-only` exists for the opposite
reason: on a real desktop the interesting failures are the thirty-eight, and
being able to run only those is what makes a live proof cheap enough to repeat.

The gate sits at the repository root rather than inside ``service/`` because the
service is no longer the only thing with tests. An option registered in a
subdirectory is not registered at all until pytest has already parsed the
command line, so ``pytest --no-live`` from the root — the line every issue and
every sandboxed worktree quotes — died on its own argument. One gate at the top
answers for every suite beneath it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

#: ``desktop_service`` and the service's own ``tests`` package used to be
#: importable because pytest was run from inside ``service/``. Run from the
#: root, that directory is on nobody's path, so the suites are placed here
#: instead of depending on a working directory.
ROOT = Path(__file__).resolve().parent
for package_root in (ROOT / "service", ROOT / "clients" / "recorder"):
    sys.path.insert(0, str(package_root))

#: A live test is one that drives a session it did not create. The suffix is
#: the declaration; this module turns it into a marker so that nothing depends
#: on a reader noticing the file name.
LIVE_SUFFIX = "_live"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "live: drives a real desktop session. Deselected when no display is reachable.",
    )


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("desktop")
    group.addoption(
        "--live-only",
        action="store_true",
        default=False,
        help="Run only the tests that drive a real desktop.",
    )
    group.addoption(
        "--no-live",
        action="store_true",
        default=False,
        help="Skip the tests that drive a real desktop, even if one is available.",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    for item in items:
        if item.module.__name__.endswith(LIVE_SUFFIX):
            item.add_marker(pytest.mark.live)

    reason = _why_live_is_unavailable(config)
    live_only = config.getoption("--live-only")

    for item in items:
        is_live = item.get_closest_marker("live") is not None
        if is_live and reason:
            item.add_marker(pytest.mark.skip(reason=reason))
        elif live_only and not is_live:
            item.add_marker(pytest.mark.skip(reason="deselected by --live-only"))


def _why_live_is_unavailable(config: pytest.Config) -> str:
    """The reason a desktop cannot be driven here, or an empty string.

    Phrased as a reason rather than a boolean because the skip line is the whole
    point: a run in a container should say *no display* instead of leaving the
    reader to guess whether the tests were absent, broken or deliberately off.

    Availability is probed by connecting, never by reading an environment
    variable, because that is already the rule everywhere else in this service:
    a session started from a shell inherits no ``DISPLAY`` and drives a desktop
    perfectly well once it has found one. Asking the same backend the service
    asks means a suite and the thing it tests cannot disagree about whether a
    desktop is present.
    """
    if config.getoption("--no-live"):
        return "deselected by --no-live"

    from desktop_service.backends import x11

    try:
        if x11.available():
            return ""
        detail = x11.unavailable_reason() or "no display answered"
    except Exception as failure:  # pragma: no cover - probing must never error out
        detail = str(failure) or failure.__class__.__name__

    return f"no desktop session is reachable from here: {detail}"
