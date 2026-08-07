"""The accessibility bus is asked about over D-Bus, never by trying it.

`Atspi` reports a missing accessibility bus by aborting the process: a
`dbind-ERROR` goes through `g_error`, `g_error` calls `abort()`, and no Python
`except` runs. A shared daemon that does this takes every connected client with
it, and a test suite that does it dumps core instead of reporting a failure —
which is strictly worse, because a core dump cannot tell you whether the repo is
broken or the machine is.

So these tests run the dangerous thing in a subprocess with the session bus
pointed at nothing. A regression here shows up as a non-zero exit and a corpse
rather than a red assertion, which is the whole reason the guard exists.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]

#: A socket path that cannot be a bus, so the probe has something real to fail on.
DEAD_BUS = "unix:path=/nonexistent/definitely-not-a-bus"


def _in_a_bus_less_process(body: str) -> subprocess.CompletedProcess[str]:
    """Run `body` with no reachable session bus, and survive whatever it does."""
    return subprocess.run(
        [sys.executable, "-c", body],
        cwd=SERVICE_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        env={
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": str(SERVICE_ROOT),
            "DBUS_SESSION_BUS_ADDRESS": DEAD_BUS,
            "HOME": "/tmp",
        },
    )


def test_the_toolkit_really_does_abort_without_a_bus():
    """The premise. If this ever stops being true, the guard can go.

    Asserting the failure mode rather than assuming it: the guard below is only
    worth its complexity for as long as the toolkit answers this question with a
    core dump instead of an exception.
    """
    done = _in_a_bus_less_process(
        "import gi\n"
        "gi.require_version('Atspi', '2.0')\n"
        "from gi.repository import Atspi\n"
        "try:\n"
        "    Atspi.get_desktop(0).get_child_count()\n"
        "except Exception as exc:\n"
        "    print('RAISED', type(exc).__name__)\n"
    )
    assert done.returncode != 0, "the toolkit no longer aborts; the guard may be removable"
    assert "RAISED" not in done.stdout, "it raised — that would have been catchable all along"


def test_the_probe_reports_instead_of_dying():
    done = _in_a_bus_less_process(
        "from desktop_service.backends import atspi\n"
        "reachable, reason = atspi.bus_reachable()\n"
        "print('REACHABLE', reachable)\n"
        "print('REASON', reason)\n"
    )
    assert done.returncode == 0, f"the probe died: {done.stderr[-400:]}"
    assert "REACHABLE False" in done.stdout
    assert "no accessibility bus" in done.stdout


def test_probe_desktop_answers_unavailable_without_a_bus():
    """The service's own availability question, asked where the answer is no."""
    done = _in_a_bus_less_process(
        "from desktop_service.backends import atspi\n"
        "print('REPORT', atspi.probe_desktop())\n"
    )
    assert done.returncode == 0, f"probe_desktop died: {done.stderr[-400:]}"
    assert "'available': False" in done.stdout


def test_a_deep_lookup_survives_a_bus_less_machine():
    """The case the first version of this guard missed.

    Guarding `probe_desktop` looked like enough and was not: a window lookup
    several layers under `typeText` reaches the toolkit's root by its own path,
    and that one still aborted. The test is written against the deep call rather
    than the probe, because the probe was never the one that killed a test run.
    """
    done = _in_a_bus_less_process(
        "from desktop_service.backends import atspi\n"
        "print('WINDOW', atspi.find_window('win-nothing'))\n"
        "print('APPS', list(atspi._iter_desktop_apps()))\n"
    )
    assert done.returncode == 0, f"a deep lookup still aborts: {done.stderr[-400:]}"
    assert "WINDOW None" in done.stdout
    assert "APPS []" in done.stdout


def test_watching_events_on_a_bus_less_machine_watches_nothing():
    """Registering a listener connects, and connecting is what aborts.

    The third route in, and the one that asks for no desktop at all — which is
    why funnelling the desktop lookups did not cover it.
    """
    done = _in_a_bus_less_process(
        "from desktop_service.backends import atspi\n"
        "stop = atspi.watch_events(lambda: None)\n"
        "print('SUBSCRIBED')\n"
        "stop()\n"
        "print('UNSUBSCRIBED')\n"
    )
    assert done.returncode == 0, f"watching events still aborts: {done.stderr[-400:]}"
    assert "SUBSCRIBED" in done.stdout
    assert "UNSUBSCRIBED" in done.stdout


def test_a_yes_is_not_re_asked_on_every_call():
    """The guard sits on hot paths. A round trip per call would be a tax on all of them."""
    from desktop_service.backends import atspi

    atspi.forget_bus_answer()
    calls = {"n": 0}
    real = atspi._ask_the_bus

    def counted():
        calls["n"] += 1
        return real()

    atspi._ask_the_bus = counted
    try:
        for _ in range(50):
            atspi.bus_reachable()
    finally:
        atspi._ask_the_bus = real
        atspi.forget_bus_answer()

    assert calls["n"] == 1, f"the bus was asked {calls['n']} times for one answer"


def test_a_no_is_re_asked_so_a_late_desktop_is_noticed():
    """A desktop that starts after the service did should not need a restart."""
    from desktop_service.backends import atspi

    atspi.forget_bus_answer()
    answers = iter([(False, "not yet"), (True, None)])
    real = atspi._ask_the_bus
    atspi._ask_the_bus = lambda: next(answers)
    try:
        assert atspi.bus_reachable() == (False, "not yet")
        atspi._bus_asked_at -= atspi.BUS_RETRY_SECONDS + 1
        assert atspi.bus_reachable() == (True, None)
    finally:
        atspi._ask_the_bus = real
        atspi.forget_bus_answer()


def test_the_loop_starts_and_says_why_it_is_empty():
    """A bus-less machine gets a running service that reports itself unavailable.

    Not a dead one. The distinction matters to a client: a service that answers
    `available: false` can be asked what is wrong, and a process that aborted on
    boot cannot be asked anything.
    """
    done = _in_a_bus_less_process(
        "from desktop_service.backends import loop\n"
        "desk = loop.DesktopLoop()\n"
        "desk.start()\n"
        "print('RUNNING', desk.is_running)\n"
        "desk.stop()\n"
        "print('STOPPED')\n"
    )
    assert done.returncode == 0, f"the loop died on a bus-less machine: {done.stderr[-400:]}"
    assert "RUNNING True" in done.stdout
    assert "STOPPED" in done.stdout
