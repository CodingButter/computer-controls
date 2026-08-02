"""What the logged-in desktop session says about itself, when our own does not.

A service started from an SSH shell, a `tmux` pane or a systemd unit inherits
that context's environment, and that environment describes a terminal rather than
a desktop: `XDG_SESSION_TYPE=tty`, no `XDG_CURRENT_DESKTOP` at all. Reporting
those values would be a service sitting on a working GNOME desktop, driving it
successfully, and announcing that it cannot see one.

This is the same failure the display discovery already fixed once: the daemon
found the display by looking for it, and then described its session from
variables nobody had set. So the session is discovered the same way — by asking
the desktop's own processes what environment they were started with.

Reading `/proc` is Linux-specific, which is why it lives under `backends/`
alongside everything else that would be rewritten for another operating system.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Processes that only exist inside a running graphical session. The first one
#: that answers wins; none of them is guaranteed to be present, which is why
#: there is a list rather than a name.
SESSION_PROCESSES = (
    "gnome-shell",
    "gnome-session-binary",
    "plasmashell",
    "xfce4-session",
    "sway",
)

#: The variables worth borrowing. Deliberately short: this is session
#: description, not an environment transplant, and copying anything a caller
#: could confuse for a credential would be a poor trade for a tidier report.
BORROWED = ("XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY")


def _environ_of(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return {}
    found = {}
    for entry in raw.split(b"\0"):
        key, sep, value = entry.partition(b"=")
        if sep:
            found[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return found


def _session_pids() -> list[int]:
    """Our own user's graphical-session processes, newest last."""
    uid = os.getuid()
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != uid:
                continue
            command = (entry / "comm").read_text().strip()
        except OSError:
            continue
        if command in SESSION_PROCESSES:
            found.append(int(entry.name))
    return found


def discover() -> dict[str, str]:
    """Session variables borrowed from a desktop process, or an empty dict.

    Empty means no graphical session belonging to this user was found — which is
    a real answer on a headless machine, and better than a guess.
    """

    for pid in _session_pids():
        environ = _environ_of(pid)
        borrowed = {key: environ[key] for key in BORROWED if environ.get(key)}
        if borrowed.get("XDG_CURRENT_DESKTOP"):
            return borrowed
    return {}
