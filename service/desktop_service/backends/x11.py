"""The compositor tier on X11: which window is active, and how to make one active.

Two facts forced this module's shape, and both are worth stating because neither is
obvious from the outside.

First, **AT-SPI on this desktop does not report which window is active.** Not one window
in the session exposes the `active` state, so focus is not observable through the
accessibility layer at all. The display server knows, and it will say so through the
EWMH properties every conforming window manager maintains.

Second, **the introspected Gdk property API is unusable.** `Gdk.property_get` cannot be
called through GObject Introspection — it fails to allocate its output argument — so
reading `_NET_ACTIVE_WINDOW` through Gdk is not available regardless of how reasonable
it looks. The reads therefore go to libX11 through ctypes, which adds no dependency:
libX11 is loaded by definition in a session that has an X display.

Writing focus is different from reading it. `XSetInputFocus` fights the window manager,
which is entitled to refuse or undo it. Gdk's `focus()` sends the `_NET_ACTIVE_WINDOW`
client message the window manager is expecting, so the manager cooperates instead. Reads
through ctypes, the one write through Gdk — each by the path that actually works.

Nothing here addresses a window by coordinates. An X window id is an opaque handle the
display server assigned, not a position on a screen.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
from dataclasses import dataclass
from typing import Any

BACKEND = "x11"

_ANY_PROPERTY_TYPE = 0
_MAX_PROPERTY_WORDS = 4096

# X protocol constants. Named rather than inlined, because a bare 33 in a send call is
# the kind of thing nobody can check later.
_CLIENT_MESSAGE = 33
_CURRENT_TIME = 0
_SOURCE_PAGER = 2
_SUBSTRUCTURE_NOTIFY = 1 << 19
_SUBSTRUCTURE_REDIRECT = 1 << 20


@dataclass(frozen=True)
class X11Window:
    """One toplevel window as the display server describes it."""

    xid: int
    pid: int
    title: str


class _Xlib:
    """The handful of libX11 entry points this backend needs, bound once."""

    def __init__(self) -> None:
        library = ctypes.util.find_library("X11")
        if library is None:
            raise OSError("libX11 not found")
        self.lib = ctypes.CDLL(library)
        self.lib.XOpenDisplay.restype = ctypes.c_void_p
        self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.lib.XInternAtom.restype = ctypes.c_ulong
        self.lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        self.lib.XDefaultRootWindow.restype = ctypes.c_ulong
        self.lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.lib.XFree.argtypes = [ctypes.c_void_p]
        self.lib.XGetWindowProperty.restype = ctypes.c_int
        self.lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_long,
            ctypes.c_long,
            ctypes.c_int,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
        ]
        self.display = self.lib.XOpenDisplay(None)
        if not self.display:
            raise OSError("cannot open the X display")
        self.root = self.lib.XDefaultRootWindow(self.display)

    def property_of(self, window: int, name: str) -> list[int] | bytes | None:
        """Read one window property, or None when the window does not carry it.

        A window that vanished between being listed and being read is not an error
        here; it is the normal state of a desktop, and the caller gets None.
        """
        atom = self.lib.XInternAtom(self.display, name.encode(), False)
        actual_type = ctypes.c_ulong()
        actual_format = ctypes.c_int()
        count = ctypes.c_ulong()
        remaining = ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        status = self.lib.XGetWindowProperty(
            self.display,
            window,
            atom,
            0,
            _MAX_PROPERTY_WORDS,
            False,
            _ANY_PROPERTY_TYPE,
            ctypes.byref(actual_type),
            ctypes.byref(actual_format),
            ctypes.byref(count),
            ctypes.byref(remaining),
            ctypes.byref(data),
        )
        if status != 0 or not data:
            return None
        try:
            if actual_format.value == 32:
                words = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))
                return [words[i] for i in range(count.value)]
            return bytes(bytearray(data[i] for i in range(count.value)))
        finally:
            self.lib.XFree(data)


_xlib: _Xlib | None = None
_unavailable_reason = ""
_attached_display = ""


def _discover_display() -> list[tuple[str, str]]:
    """Candidate displays for a process that inherited no `DISPLAY`.

    This is not a convenience. The service is meant to outlive the client that started
    it and to be reachable from a client that is somewhere else entirely — an SSH session,
    another machine, eventually no terminal at all. Such a client hands down no display,
    and a desktop service that can only see the desktop when it is launched from inside
    one is not the thing this project is building.

    The accessibility tier already works that way: it finds the session over D-Bus rather
    than through the environment. This brings the compositor tier to the same standing.

    Discovery, never invention: the candidates are the display sockets the X server
    actually created, paired with the authority files that exist. An explicit `DISPLAY`
    is always honoured and never second-guessed.
    """
    candidates: list[tuple[str, str]] = []
    try:
        sockets = sorted(os.listdir("/tmp/.X11-unix"))
    except OSError:
        return candidates

    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    authorities = [
        path
        for path in (
            os.environ.get("XAUTHORITY", ""),
            f"{runtime}/gdm/Xauthority",
            os.path.expanduser("~/.Xauthority"),
        )
        if path and os.path.exists(path)
    ]

    for socket_name in sockets:
        if not socket_name.startswith("X"):
            continue
        display = f":{socket_name[1:]}"
        for authority in authorities or [""]:
            candidates.append((display, authority))
    return candidates


def available() -> bool:
    """Whether the compositor tier can answer at all in this session.

    Probed by using it, never by trusting an environment variable — the same rule the
    capability report already follows for the accessibility bridge.
    """
    return _connect() is not None


def unavailable_reason() -> str:
    _connect()
    return _unavailable_reason


def _connect() -> _Xlib | None:
    global _xlib, _unavailable_reason, _attached_display
    if _xlib is not None or _unavailable_reason:
        return _xlib

    attempts: list[tuple[str, str]] = []
    if os.environ.get("DISPLAY"):
        attempts.append((os.environ["DISPLAY"], os.environ.get("XAUTHORITY", "")))
    else:
        attempts.extend(_discover_display())

    failures: list[str] = []
    for display, authority in attempts:
        previous = (os.environ.get("DISPLAY"), os.environ.get("XAUTHORITY"))
        os.environ["DISPLAY"] = display
        if authority:
            os.environ["XAUTHORITY"] = authority
        try:
            _xlib = _Xlib()
            _attached_display = display
            return _xlib
        except Exception as exc:  # this display refused us; try the next one
            failures.append(f"{display}: {exc}")
            for key, value in zip(("DISPLAY", "XAUTHORITY"), previous):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    _unavailable_reason = (
        "; ".join(failures) if failures else "no X display socket found for this session"
    )
    return None


def attached_display() -> str:
    """Which display this backend is driving. Empty when it never attached.

    Reported rather than assumed: a service that found the desktop by discovery should
    say which one it found, or the first surprising answer costs an hour of looking in
    the wrong session.
    """
    _connect()
    return _attached_display


def window_property(xid: int, name: str) -> list[int] | bytes | None:
    """One property of one window, or None when the window or the property is absent.

    Exposed because the vision tier needs `_GTK_FRAME_EXTENTS` to know how much of a
    capture is invisible shadow, and reaching into this module's connection from
    outside it would put display-server details in two places.
    """
    xlib = _connect()
    if xlib is None:
        return None
    return xlib.property_of(xid, name)


def _decode(value: list[int] | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return ""


def active_xid() -> int | None:
    """The X id of the active window, or None when nothing is active."""
    xlib = _connect()
    if xlib is None:
        return None
    value = xlib.property_of(xlib.root, "_NET_ACTIVE_WINDOW")
    if isinstance(value, list) and value:
        return value[0] or None
    return None


def toplevels() -> list[X11Window]:
    """Every managed toplevel window, with the pid and title that identify it.

    The pid and title are what let a window the display server knows about be matched to
    the same window the accessibility layer knows about. Neither layer shares an id with
    the other, so the match is made on facts both of them report.
    """
    xlib = _connect()
    if xlib is None:
        return []
    clients = xlib.property_of(xlib.root, "_NET_CLIENT_LIST")
    if not isinstance(clients, list):
        return []
    windows = []
    for xid in clients:
        pid_value = xlib.property_of(xid, "_NET_WM_PID")
        pid = pid_value[0] if isinstance(pid_value, list) and pid_value else 0
        title = _decode(xlib.property_of(xid, "_NET_WM_NAME"))
        if not title:
            title = _decode(xlib.property_of(xid, "WM_NAME"))
        windows.append(X11Window(xid=xid, pid=pid, title=title))
    return windows


def activate(xid: int) -> bool:
    """Ask the window manager to make this window active.

    Deliberately not `XSetInputFocus`. Focus belongs to the window manager, and a client
    that seizes it directly gets into an argument it can lose silently — the focus moves
    and then moves back, and the caller is told it succeeded. The `_NET_ACTIVE_WINDOW`
    client message is a request the manager honours on its own terms.

    Also deliberately not Gdk's `focus()`, which needs a timestamp, and whose way of
    obtaining one — `x11_get_server_time` — **hangs forever on a foreign window**. It
    sets a property and waits for the resulting `PropertyNotify`, and a window this
    process does not own has no event mask selected, so the notification never arrives.
    That is a deadlock, not a slow call. `CurrentTime` costs nothing and asks the manager
    to decide for itself, which it is better placed to do anyway.

    Whether it worked is decided by reading the active window back, never by the return
    value of the request: this function reports that the message was sent, and the caller
    reports what the desktop did.
    """
    xlib = _connect()
    if xlib is None:
        return False

    class _ClientMessage(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_int),
            ("serial", ctypes.c_ulong),
            ("send_event", ctypes.c_int),
            ("display", ctypes.c_void_p),
            ("window", ctypes.c_ulong),
            ("message_type", ctypes.c_ulong),
            ("format", ctypes.c_int),
            ("data", ctypes.c_long * 5),
            ("padding", ctypes.c_long * 18),
        ]

    xlib.lib.XSendEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_long,
        ctypes.c_void_p,
    ]
    xlib.lib.XFlush.argtypes = [ctypes.c_void_p]

    event = _ClientMessage()
    event.type = _CLIENT_MESSAGE
    event.send_event = True
    event.display = xlib.display
    event.window = xid
    event.message_type = xlib.lib.XInternAtom(xlib.display, b"_NET_ACTIVE_WINDOW", False)
    event.format = 32
    event.data[0] = _SOURCE_PAGER
    event.data[1] = _CURRENT_TIME
    event.data[2] = 0

    sent = xlib.lib.XSendEvent(
        xlib.display,
        xlib.root,
        False,
        _SUBSTRUCTURE_REDIRECT | _SUBSTRUCTURE_NOTIFY,
        ctypes.byref(event),
    )
    xlib.lib.XFlush(xlib.display)
    return bool(sent)


class _ScreenSaverInfo(ctypes.Structure):
    _fields_ = [
        ("window", ctypes.c_ulong),
        ("state", ctypes.c_int),
        ("kind", ctypes.c_int),
        ("til_or_since", ctypes.c_ulong),
        ("idle", ctypes.c_ulong),
        ("event_mask", ctypes.c_ulong),
    ]


_xss: Any = None
_xss_info: Any = None
_xss_reason = ""


def _screensaver() -> Any:
    """The MIT-SCREEN-SAVER extension, bound once, or None with a reason kept.

    Bound separately from libX11 because it is an extension: a display server can be
    perfectly healthy and still not offer it, and that is a fact about the session
    rather than a failure of this backend.
    """
    global _xss, _xss_info, _xss_reason
    if _xss is not None or _xss_reason:
        return _xss
    xlib = _connect()
    if xlib is None:
        _xss_reason = unavailable_reason()
        return None
    library = ctypes.util.find_library("Xss")
    if library is None:
        _xss_reason = "libXss not found"
        return None
    try:
        lib = ctypes.CDLL(library)
        lib.XScreenSaverQueryExtension.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        event_base = ctypes.c_int()
        error_base = ctypes.c_int()
        if not lib.XScreenSaverQueryExtension(
            xlib.display, ctypes.byref(event_base), ctypes.byref(error_base)
        ):
            _xss_reason = "this display server does not offer MIT-SCREEN-SAVER"
            return None
        lib.XScreenSaverAllocInfo.restype = ctypes.POINTER(_ScreenSaverInfo)
        lib.XScreenSaverQueryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(_ScreenSaverInfo),
        ]
        _xss_info = lib.XScreenSaverAllocInfo()
        if not _xss_info:
            _xss_reason = "the screen saver extension would not allocate"
            return None
        _xss = lib
        return _xss
    except Exception as exc:  # a broken extension is a missing one, told honestly
        _xss_reason = str(exc)
        return None


def idle_ms() -> int | None:
    """Milliseconds since the last input the display server saw. None when it cannot say.

    This is the whole presence mechanism, and its shape is the point: the X server will
    tell us *when* input last happened and nothing whatsoever about what it was. No key,
    no button, no window it went to. That is the difference between a clock and a
    keylogger, and it is why presence can be read continuously without the service ever
    becoming something a person would want turned off.

    It is also why presence alone decides nothing. Any input resets this counter —
    a keystroke, a click, a mouse nudge on the way past — so the number says a human is
    *at* the machine, never that they are reaching for the field we are writing in. The
    destination carries that test; this only bounds it in time.
    """
    lib = _screensaver()
    if lib is None:
        return None
    xlib = _connect()
    if xlib is None:
        return None
    if not lib.XScreenSaverQueryInfo(xlib.display, xlib.root, _xss_info):
        return None
    return int(_xss_info.contents.idle)


def presence_unavailable_reason() -> str:
    """Why idle time cannot be read here, for a capability report to quote."""
    _screensaver()
    return _xss_reason
