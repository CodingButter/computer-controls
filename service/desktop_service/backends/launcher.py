"""Starting applications, without ever being handed a command to run.

Every other method in this service acts on a window that already exists. This one creates
one, which makes it the only place where a caller could plausibly ask the service to
*execute something* — and the exact place where that must be refused. A launch takes an
application id drawn from the enumeration below and nothing else. No command line, no
argument vector, no path. The moment a model can hand this service a string to run, it
stops being a semantic desktop plugin and becomes a remote shell with extra steps.

The enumeration is the desktop's own: the installed desktop entries, the same list the
shell's application grid is built from. An id that is not in it cannot be launched,
because there is no other way in.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from gi.repository import Gio

from .. import model
from . import x11

log = logging.getLogger(__name__)

BACKEND_NAME = "app-native"


def _entry(entry_id: str) -> Gio.DesktopAppInfo | None:
    """Resolve a desktop entry id, or nothing.

    `Gio.DesktopAppInfo.new` raises rather than returning None through the Python
    bindings when the id is unknown, which reads as a crash at the call site for what is
    an ordinary "no such application" answer.
    """
    try:
        return Gio.DesktopAppInfo.new(entry_id)
    except Exception:  # noqa: BLE001 - an unknown id is an answer, not a fault
        return None


def list_installable() -> list[dict[str, Any]]:
    """The applications this desktop can start, as the desktop itself describes them.

    Entries the shell would hide are hidden here too. A launcher that could start things
    the user cannot see in their own application grid would be a different, larger
    capability than the one this method claims to be.
    """
    entries: list[dict[str, Any]] = []
    for info in Gio.AppInfo.get_all():
        if not info.should_show():
            continue
        entry_id = info.get_id()
        if not entry_id:
            continue
        entries.append(
            {
                "id": entry_id,
                # Through the one door, like every other piece of text that leaves this
                # service. An application's own name is the least likely thing a
                # redaction policy will ever hold back, which is exactly why exempting
                # it "just this once" is how the choke point becomes decorative.
                "name": model.egress_value(
                    info.get_display_name() or entry_id,
                    field=model.NAME,
                    role="application",
                    element_id=entry_id,
                ),
                "description": model.egress_value(
                    info.get_description() or "",
                    field=model.NAME,
                    role="application",
                    element_id=entry_id,
                ),
            }
        )
    entries.sort(key=lambda entry: entry["name"].casefold())
    return entries


def exists(entry_id: str) -> bool:
    return _entry(entry_id) is not None


def _launch_context() -> Gio.AppLaunchContext:
    """A launch context pointed at the display this service actually found.

    A service that discovers the desktop instead of inheriting it must hand what it
    found to the applications it starts, or they inherit the service's blindness. This
    failed exactly that way the first time it ran: GIO reported a successful launch, the
    application exited immediately because it had no display to open, and the honest
    answer "the launch worked, no window appeared" was indistinguishable from a slow
    cold start.
    """
    context = Gio.AppLaunchContext()
    display = x11.attached_display() or os.environ.get("DISPLAY", "")
    if display:
        context.setenv("DISPLAY", display)
    authority = os.environ.get("XAUTHORITY", "")
    if authority:
        context.setenv("XAUTHORITY", authority)
    return context


def launch(entry_id: str) -> int:
    """Start an application through its desktop entry, and say which process it became.

    Launched through GIO rather than spawned: applications that declare themselves
    D-Bus activatable are started by the session bus, so they belong to the session
    rather than to this service, and outlive it the way an application started from the
    shell does.

    Returns the launched process id, or 0 for a launch that produced no process this
    service can name — a D-Bus activated application is started by the bus, and the bus
    does not report back whose it is. 0 is not a failure; it is the honest statement that
    the window this launch opens cannot be recognised as ours by process identity, which
    is what the caller needs in order not to claim somebody else's window.
    """
    info = _entry(entry_id)
    if info is None:
        return 0
    launched: dict[str, int] = {}

    def remember(_context, _info, platform_data) -> None:
        pid = platform_data.lookup_value("pid", None) if platform_data else None
        if pid is not None:
            launched["pid"] = int(pid.get_int32())

    context = _launch_context()
    handler = context.connect("launched", remember)
    try:
        if not info.launch(None, context):
            return 0
    except Exception as exc:  # noqa: BLE001 - a failed launch is a result, not a crash
        log.debug("launch of %s failed: %s", entry_id, exc)
        return 0
    finally:
        context.disconnect(handler)
    return launched.get("pid", 0)


def descends_from(pid: int, ancestor: int, max_generations: int = 6) -> bool:
    """Whether a running process is the one we launched, or was started by it.

    Applications routinely re-exec or hand off to a child, so the process GIO reports is
    frequently not the process that owns the window seconds later. Walking up from the
    candidate answers "is this ours" without guessing from timing, which is the whole
    point: a window that appeared while we were waiting is not evidence, and a window
    belonging to a process we started is.
    """
    if pid <= 0 or ancestor <= 0:
        return False
    current = pid
    for _ in range(max_generations):
        if current == ancestor:
            return True
        try:
            with open(f"/proc/{current}/stat", "rb") as handle:
                fields = handle.read().rpartition(b")")[2].split()
            current = int(fields[1])
        except (OSError, IndexError, ValueError):
            return False
        if current <= 1:
            return False
    return False
