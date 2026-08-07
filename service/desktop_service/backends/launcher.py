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

import contextlib
import logging
import os
import re
import tempfile
from typing import Any

from gi.repository import Gio

from .. import model
from . import x11

log = logging.getLogger(__name__)

BACKEND_NAME = "app-native"

#: The flag that makes a Chromium renderer build an accessibility tree.
#:
#: The hub cures installed launchers with this same flag, but a launch that
#: starts here never reads those files — GIO runs the entry's own Exec line. An
#: application the agent started itself would therefore be the one window it
#: could not read, which is exactly backwards.
ACCESSIBILITY_FLAG = "--force-renderer-accessibility"

#: Kept in step with CHROMIUM_BINARIES in client/src/curing/curing.ts, and held
#: there by a test in tests/test_launcher_accessibility.py. Duplicated rather
#: than shared because protocol/ carries the wire protocol; a runtime file
#: dependency would tie the packaged daemon to the presence of the client
#: checkout, which a released service does not have.
CHROMIUM_BINARIES = frozenset(
    {
        "brave",
        "brave-browser",
        "chrome",
        "chromium",
        "chromium-browser",
        "code",
        "code-insiders",
        "discord",
        "electron",
        "google-chrome",
        "google-chrome-stable",
        "microsoft-edge",
        "msedge",
        "obsidian",
        "opera",
        "signal-desktop",
        "slack",
        "spotify",
        "vivaldi",
    }
)

#: Wrappers that start something else; the interesting token is the next one.
_WRAPPERS = frozenset({"env", "sh", "bash", "exec", "nohup", "setsid"})


def _tokenize(exec_line: str) -> list[str]:
    return re.findall(r'"[^"]*"|\S+', exec_line)


def _basename_of(token: str) -> str:
    unquoted = token.strip('"')
    return os.path.basename(unquoted).lower().removesuffix(".exe")


def exec_program(exec_line: str) -> str | None:
    """The basename of the program an Exec line actually starts."""
    for token in _tokenize(exec_line):
        if token.startswith("-"):
            continue
        if "=" in token and "/" not in token:
            continue
        name = _basename_of(token)
        if name in _WRAPPERS:
            continue
        return name
    return None


def is_chromium_exec(exec_line: str) -> bool:
    return exec_program(exec_line) in CHROMIUM_BINARIES


def is_cured(exec_line: str) -> bool:
    return any(token.strip('"') == ACCESSIBILITY_FLAG for token in _tokenize(exec_line))


def cure_exec_line(exec_line: str) -> str:
    """The same Exec line with the flag directly after the program.

    After the program rather than at the end because the end is where the field
    codes live (%U, %F): the launcher substitutes real arguments there, and a
    flag placed after them arrives after the URL it was meant to precede.
    """
    if is_cured(exec_line):
        return exec_line
    tokens = _tokenize(exec_line)
    if not tokens:
        return exec_line
    insert_at = 1
    for index, token in enumerate(tokens):
        if token.startswith("-"):
            continue
        if "=" in token and "/" not in token:
            continue
        if _basename_of(token) in _WRAPPERS:
            continue
        insert_at = index + 1
        break
    return " ".join([*tokens[:insert_at], ACCESSIBILITY_FLAG, *tokens[insert_at:]])


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

    accessible, cleanup = _with_accessibility(info)
    try:
        return _launch(accessible, entry_id)
    finally:
        cleanup()


def _with_accessibility(info: Gio.DesktopAppInfo) -> tuple[Gio.DesktopAppInfo, Any]:
    """The same application, launched so its renderer builds an accessibility tree.

    Returns the original entry and a no-op whenever anything at all is unusual: a
    non-Chromium application, an entry already carrying the flag, or any failure
    building the temporary copy. A missing flag costs readability; a launch that
    raises costs the agent its hands, so this never turns a working launch into an
    exception.
    """
    filename = info.get_filename()
    if not filename:
        return info, lambda: None

    try:
        with open(filename, encoding="utf-8") as handle:
            source = handle.read()
    except OSError:
        return info, lambda: None

    exec_lines = re.findall(r"^\s*Exec\s*=\s*(.*)$", source, flags=re.MULTILINE)
    if not exec_lines or not any(is_chromium_exec(line) for line in exec_lines):
        return info, lambda: None
    if all(is_cured(line) for line in exec_lines):
        return info, lambda: None

    cured = re.sub(
        r"^(\s*Exec\s*=)(.*)$",
        lambda match: f"{match.group(1)}{cure_exec_line(match.group(2))}",
        source,
        flags=re.MULTILINE,
    )
    # A D-Bus activatable application is started by the session bus from its own
    # service file and never reads this Exec line at all, so the flag would be
    # silently dropped. Turning activation off is what makes the rewrite mean
    # something — at the cost that the application becomes this service's child
    # rather than the bus's, which is visible in the pid this function reports.
    cured = re.sub(r"^\s*DBusActivatable\s*=.*$", "DBusActivatable=false", cured, flags=re.MULTILINE)
    if "DBusActivatable" not in cured:
        cured = cured.replace("[Desktop Entry]", "[Desktop Entry]\nDBusActivatable=false", 1)

    try:
        handle, temporary = tempfile.mkstemp(prefix="comcon-launch-", suffix=".desktop")
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(cured)
    except OSError:
        return info, lambda: None

    def cleanup() -> None:
        with contextlib.suppress(OSError):
            os.unlink(temporary)

    # Written to a file and loaded back rather than built in memory:
    # Gio.DesktopAppInfo.new_from_keyfile() returns NULL through these bindings
    # even for an unmodified valid keyfile, so the constructor that looks right
    # here does not work. Verified against pygobject 3.48.2 — do not "simplify"
    # this back into new_from_keyfile.
    #
    # new_from_filename() also returns None when the Exec program is not on
    # PATH, which looks identical to a binding bug and is not one.
    copy = Gio.DesktopAppInfo.new_from_filename(temporary)
    if copy is None:
        cleanup()
        return info, lambda: None
    return copy, cleanup


def _launch(info: Gio.DesktopAppInfo, entry_id: str) -> int:
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
