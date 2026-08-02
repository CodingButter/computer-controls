"""The single GLib main loop thread that owns all toolkit access.

`Atspi` is not thread-safe and its event delivery requires a running GLib main
loop, so this service fixes one rule and every later phase obeys it:

    one thread owns the loop, and every call that touches the desktop runs on it.

The socket server accepts connections on its own threads and marshals each
backend call here with `call_on_loop`, which blocks the calling thread until the
loop has produced a result. Later phases add event callbacks, debounce timers and
a reconciliation sweep — all of them attach to this same loop as GLib sources
rather than starting threads of their own.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, TypeVar

import gi

gi.require_version("Atspi", "2.0")

from gi.repository import Atspi, GLib  # noqa: E402  (must follow require_version)

from ..errors import DesktopError, ErrorCode, TimeoutError_

log = logging.getLogger(__name__)

T = TypeVar("T")

DEFAULT_CALL_TIMEOUT_SECONDS = 15.0


class DesktopLoop:
    """Owns the GLib main loop and marshals work onto its thread."""

    def __init__(self) -> None:
        self._loop: GLib.MainLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._lock = threading.Lock()
        #: Callers blocked on a marshalled call. On shutdown they are released
        #: with an error instead of being left to burn their whole timeout: a
        #: client waiting fifteen seconds for a service that already stopped
        #: learns nothing the first second could not have told it.
        self._pending: set[threading.Event] = set()
        self._stopping = False

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, timeout: float = 10.0) -> None:
        with self._lock:
            if self.is_running:
                return
            self._ready.clear()
            # The *default* context, not a private one. AT-SPI registers its D-Bus event
            # dispatch on the default context when it initialises, so a loop running any
            # other context receives no desktop events at all — and the failure is silent:
            # calls keep working, subscriptions register successfully, and nothing ever
            # arrives. This cost an hour; the events only appeared once the loop ran the
            # context the toolkit was already talking to.
            context = GLib.MainContext.default()
            self._loop = GLib.MainLoop.new(context, False)
            self._thread = threading.Thread(
                target=self._run, name="desktop-glib-loop", daemon=True
            )
            self._thread.start()
        if not self._ready.wait(timeout):
            raise TimeoutError_("GLib main loop startup", timeout)

    def _run(self) -> None:
        loop = self._loop
        assert loop is not None
        context = loop.get_context()
        # Acquired rather than pushed as thread-default: the default context cannot be
        # pushed, and acquiring it is what makes this thread the one allowed to run it.
        context.acquire()
        # Atspi.init() must run on the thread that owns the loop, because that is
        # the thread every subsequent Atspi call will be marshalled onto.
        try:
            Atspi.init()
        finally:
            self._ready.set()
        try:
            loop.run()
        finally:
            context.release()

    def stop(self, timeout: float = 5.0) -> None:
        with self._lock:
            loop, thread = self._loop, self._thread
            self._loop, self._thread = None, None
            self._stopping = True
            pending, self._pending = list(self._pending), set()
        # Release anyone mid-call first: their work will never finish now, and
        # the loop thread is about to stop being able to tell them so.
        for event in pending:
            event.set()
        if loop is None or thread is None:
            with self._lock:
                self._stopping = False
            return

        # The quit must be attached to *this* loop's context. `GLib.idle_add`
        # attaches to the default context, which this loop does not use, so the
        # callback would never run and shutdown would fall back to the join
        # timeout — a five second pause on every stop.
        source = GLib.idle_source_new()
        source.set_callback(lambda *_: (loop.quit(), GLib.SOURCE_REMOVE)[1])
        source.attach(loop.get_context())
        loop.get_context().wakeup()
        thread.join(timeout)
        with self._lock:
            self._stopping = False

    def call(
        self,
        fn: Callable[..., T],
        *args: Any,
        timeout: float = DEFAULT_CALL_TIMEOUT_SECONDS,
        **kwargs: Any,
    ) -> T:
        """Run `fn` on the loop thread and return its result.

        Blocks the caller. Exceptions raised inside `fn` are re-raised here, so a
        backend failure surfaces to the request handler that asked for it rather
        than killing the loop.
        """
        if not self.is_running:
            raise DesktopError(
                ErrorCode.BACKEND_UNAVAILABLE,
                "The desktop loop is not running",
                {"backend": "glib"},
            )
        if threading.current_thread() is self._thread:
            return fn(*args, **kwargs)

        done = threading.Event()
        box: dict[str, Any] = {}
        with self._lock:
            if self._stopping:
                raise DesktopError(
                    ErrorCode.BACKEND_UNAVAILABLE,
                    "The desktop loop is shutting down",
                    {"backend": "glib"},
                )
            self._pending.add(done)

        def invoke() -> bool:
            try:
                box["value"] = fn(*args, **kwargs)
            except BaseException as exc:  # noqa: BLE001 - re-raised on the caller
                box["error"] = exc
            finally:
                done.set()
            return GLib.SOURCE_REMOVE

        loop = self._loop
        if loop is None:
            raise DesktopError(
                ErrorCode.BACKEND_UNAVAILABLE,
                "The desktop loop is not running",
                {"backend": "glib"},
            )
        source = GLib.idle_source_new()
        source.set_callback(lambda *_: invoke())
        source.attach(loop.get_context())
        loop.get_context().wakeup()

        try:
            if not done.wait(timeout):
                source.destroy()
                raise TimeoutError_(getattr(fn, "__name__", "backend call"), timeout)
        finally:
            with self._lock:
                self._pending.discard(done)
        if "error" in box:
            raise box["error"]
        if "value" not in box:
            # Released by shutdown rather than by the call completing.
            raise DesktopError(
                ErrorCode.BACKEND_UNAVAILABLE,
                "The desktop loop stopped before the call completed",
                {"backend": "glib", "call": getattr(fn, "__name__", "backend call")},
            )
        return box["value"]


    def after(self, delay_ms: int, fn: Callable[[], None]) -> Callable[[], None]:
        """Run `fn` on the loop thread once, `delay_ms` from now. Returns a canceller.

        Unlike `call`, nothing waits for the result: this is how the watcher's debounce
        and its reconciliation sweep live on the same thread as every other toolkit
        access, instead of on a timer thread that would have to marshal back anyway.

        The source is attached to *this* loop's context for the same reason `stop` does
        it: `GLib.timeout_add` targets the default context, which this loop never runs,
        so the callback would simply never fire.
        """
        loop = self._loop
        if loop is None:
            raise DesktopError(
                ErrorCode.BACKEND_UNAVAILABLE,
                "The desktop loop is not running",
                {"backend": "glib"},
            )
        source = GLib.timeout_source_new(delay_ms)

        def fire(*_: Any) -> bool:
            try:
                fn()
            except Exception:
                # A watcher callback that raises must not take the loop down with it;
                # every other call in the process answers on this thread.
                log.exception("scheduled loop callback failed")
            return GLib.SOURCE_REMOVE

        source.set_callback(fire)
        source.attach(loop.get_context())
        loop.get_context().wakeup()
        return source.destroy


_loop = DesktopLoop()


def get_loop() -> DesktopLoop:
    return _loop


def after(delay_ms: int, fn: Callable[[], None]) -> Callable[[], None]:
    return _loop.after(delay_ms, fn)


def call_on_loop(
    fn: Callable[..., T],
    *args: Any,
    timeout: float = DEFAULT_CALL_TIMEOUT_SECONDS,
    **kwargs: Any,
) -> T:
    return _loop.call(fn, *args, timeout=timeout, **kwargs)
