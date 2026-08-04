"""Transport contract tests.

These use stub handlers rather than the desktop: the point is the framing, the
error behavior and the threading, none of which should depend on what happens to
be open on screen.
"""

import json
import os
import shutil
import socket
import stat
import tempfile
import threading
import time
from pathlib import Path

import pytest

from desktop_service import holds, identity
from desktop_service.protocol_generated import SCHEMA_DIGEST
from desktop_service.transport import (
    DAEMON_SESSION,
    JsonRpcServer,
    daemon_socket_path,
    default_socket_path,
    sweep_dead_daemon_sockets,
)


@pytest.fixture
def server(tmp_path):
    srv = JsonRpcServer(str(tmp_path / "test.sock"))
    srv.register("echo", lambda params: {"echoed": params})
    srv.register("boom", lambda params: (_ for _ in ()).throw(RuntimeError("kaboom")))
    srv.register("slow", lambda params: (time.sleep(params.get("seconds", 0.2)), {"ok": True})[1])
    srv.start()
    yield srv
    srv.stop()


def rpc_client(path):
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(10)
    conn.connect(path)
    return conn, conn.makefile("rwb")


def send(stream, method, params=None, request_id=1):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
    stream.write((json.dumps(payload) + "\n").encode())
    stream.flush()
    return json.loads(stream.readline())


def _wait_until(condition, timeout=5.0, interval=0.01):
    """Poll until condition() is truthy, failing the test if it never is."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(interval)
    raise AssertionError(f"condition never became true within {timeout}s")


def test_round_trip(server):
    conn, stream = rpc_client(server.socket_path)
    try:
        response = send(stream, "echo", {"x": 1})
        assert response["id"] == 1
        assert response["result"] == {"echoed": {"x": 1}}
        assert response["jsonrpc"] == "2.0"
    finally:
        conn.close()


def test_unknown_method_returns_error_and_server_survives(server):
    conn, stream = rpc_client(server.socket_path)
    try:
        response = send(stream, "does_not_exist")
        assert "error" in response
        assert response["error"]["data"]["code"] == "METHOD_NOT_FOUND"
        # The connection is still usable — an unknown method is an answer, not a crash.
        assert send(stream, "echo", {"still": "here"}, 2)["result"] == {
            "echoed": {"still": "here"}
        }
    finally:
        conn.close()


def test_handler_exception_becomes_an_error_response(server):
    conn, stream = rpc_client(server.socket_path)
    try:
        response = send(stream, "boom")
        assert response["error"]["data"]["code"] == "INTERNAL_ERROR"
        assert "kaboom" in response["error"]["message"]
        assert send(stream, "echo", {}, 2)["result"] == {"echoed": {}}
    finally:
        conn.close()


def test_malformed_line_is_answered_not_fatal(server):
    conn, stream = rpc_client(server.socket_path)
    try:
        stream.write(b"{ this is not json\n")
        stream.flush()
        response = json.loads(stream.readline())
        assert response["error"]["code"] == -32700
        assert send(stream, "echo", {}, 2)["result"] == {"echoed": {}}
    finally:
        conn.close()


def test_notification_without_id_gets_no_response(server):
    conn, stream = rpc_client(server.socket_path)
    try:
        stream.write((json.dumps({"jsonrpc": "2.0", "method": "echo", "params": {}}) + "\n").encode())
        stream.flush()
        response = send(stream, "echo", {"after": True}, 7)
        assert response["id"] == 7
    finally:
        conn.close()


def test_socket_permissions_are_owner_only(server):
    mode = os.stat(server.socket_path).st_mode
    assert stat.S_IMODE(mode) == 0o600
    assert stat.S_ISSOCK(mode)


def test_concurrent_clients_are_served(server):
    results = {}

    def worker(index):
        conn, stream = rpc_client(server.socket_path)
        try:
            results[index] = send(stream, "echo", {"i": index}, index)["result"]
        finally:
            conn.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(15)
    assert len(results) == 8
    for i in range(8):
        assert results[i] == {"echoed": {"i": i}}


def test_stale_socket_file_is_replaced(tmp_path):
    path = tmp_path / "stale.sock"
    # A crashed run leaves a socket file with nothing listening behind it.
    orphan = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    orphan.bind(str(path))
    orphan.close()
    assert path.exists()

    srv = JsonRpcServer(str(path))
    srv.register("echo", lambda params: {"echoed": params})
    srv.start()
    try:
        conn, stream = rpc_client(str(path))
        try:
            assert send(stream, "echo", {"a": 1})["result"] == {"echoed": {"a": 1}}
        finally:
            conn.close()
    finally:
        srv.stop()


def test_live_socket_is_not_stolen(server):
    """A second server must refuse rather than unlink a socket someone answers on."""
    rival = JsonRpcServer(server.socket_path)
    with pytest.raises(Exception) as excinfo:
        rival.start()
    assert "already listening" in str(excinfo.value)


def test_stop_removes_the_socket_file(tmp_path):
    srv = JsonRpcServer(str(tmp_path / "gone.sock"))
    srv.start()
    assert os.path.exists(srv.socket_path)
    srv.stop()
    assert not os.path.exists(srv.socket_path)


def test_default_socket_path_is_under_runtime_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    path = default_socket_path("abc")
    assert path == str(tmp_path / "mastracode-desktop" / "abc.sock")
    assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700


def test_loop_shutdown_is_prompt():
    """Stopping the loop must quit it, not wait out the join timeout.

    The quit source has to be attached to the loop's own context. Attaching it to
    the default context instead is silently wrong: everything still works, and
    every shutdown just takes five seconds longer than it should.
    """
    from desktop_service.backends import loop

    desktop_loop = loop.get_loop()
    desktop_loop.start()
    started = time.monotonic()
    desktop_loop.stop()
    elapsed = time.monotonic() - started
    assert not desktop_loop.is_running
    assert elapsed < 1.0, f"loop shutdown took {elapsed:.2f}s — the quit source did not run"


@pytest.mark.live
def test_concurrent_requests_on_the_glib_thread_do_not_deadlock():
    """Several clients calling the desktop at once must all be answered.

    This is the contract from `service/README.md`: connection threads marshal onto
    one GLib loop thread. A serialization bug here shows up as a hang, so the test
    joins with a timeout and fails on a thread that never finished.

    Marked live because the last assertion is about a desktop: six probes that all
    come back saying *no accessibility bus here* would satisfy every other line in
    this test while proving nothing about serialization.
    """
    from desktop_service.backends import atspi, loop

    desktop_loop = loop.get_loop()
    desktop_loop.start()
    try:
        results = {}
        errors = {}

        def worker(index):
            try:
                results[index] = loop.call_on_loop(atspi.probe_desktop, timeout=20.0)
            except Exception as exc:  # noqa: BLE001 - recorded and asserted below
                errors[index] = exc

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert not [t for t in threads if t.is_alive()], "a call never returned"
        assert not errors, f"backend calls failed: {errors}"
        assert len(results) == 6
        assert all(r["available"] for r in results.values())
    finally:
        desktop_loop.stop()


def test_the_service_gives_up_before_its_callers_do():
    """A slow-but-working sweep must not reach the model as a transport failure.

    The plugin's request timeout and the service's backend budgets are written
    in two languages in two files. If someone lowers one of them, this is the
    only thing that notices.
    """
    import re

    from desktop_service import server

    client = (
        Path(__file__).resolve().parents[2] / "plugin" / "src" / "client.ts"
    ).read_text()
    match = re.search(r"DEFAULT_REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)", client)
    assert match, "the plugin's request timeout is no longer where this test looks"
    client_budget = int(match.group(1).replace("_", "")) / 1000

    for name, budget in (
        ("WALK_TIMEOUT_SECONDS", server.WALK_TIMEOUT_SECONDS),
        ("SINGLE_ELEMENT_TIMEOUT_SECONDS", server.SINGLE_ELEMENT_TIMEOUT_SECONDS),
    ):
        assert budget < client_budget, (
            f"{name} ({budget}s) is not under the client's {client_budget}s request "
            "timeout — the client would abandon a request the service was about to "
            "answer, and the model would see a transport error instead of a result"
        )


def test_a_dropped_connection_releases_the_elements_it_was_writing(tmp_path):
    """An element owned by a process that has gone away is owned forever.

    Ownership is taken on the connection's thread, so the connection ending is
    the only moment left that can honestly give it back.
    """
    srv = JsonRpcServer(str(tmp_path / "drop.sock"))
    srv.register("hold", lambda params: {"clientId": holds.acquire(
        params["elementId"], identity.current(), "typeText"
    ).client_id})
    srv.start()
    try:
        conn, stream = rpc_client(srv.socket_path)
        client_id = send(stream, "hold", {"elementId": "el-a"})["result"]["clientId"]
        assert holds.holder("el-a").client_id == client_id

        # Both handles: a makefile keeps the socket alive, and a connection the
        # kernel has not seen close is not a connection the server has lost.
        stream.close()
        conn.close()

        deadline = time.monotonic() + 5
        while holds.holder("el-a") is not None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert holds.holder("el-a") is None, "the element stayed owned by a gone client"
    finally:
        for element_id in list(holds._holds):
            holds.release(element_id)
        srv.stop()


def test_one_connection_ending_does_not_free_another_connection_s_element(tmp_path):
    srv = JsonRpcServer(str(tmp_path / "drop-two.sock"))
    srv.register("hold", lambda params: {"clientId": holds.acquire(
        params["elementId"], identity.current(), "typeText"
    ).client_id})
    srv.start()
    try:
        first_conn, first_stream = rpc_client(srv.socket_path)
        second_conn, second_stream = rpc_client(srv.socket_path)
        send(first_stream, "hold", {"elementId": "el-a"})
        send(second_stream, "hold", {"elementId": "el-b"})

        first_stream.close()
        first_conn.close()
        deadline = time.monotonic() + 5
        while holds.holder("el-a") is not None and time.monotonic() < deadline:
            time.sleep(0.01)

        assert holds.holder("el-a") is None
        assert holds.holder("el-b") is not None
        second_stream.close()
        second_conn.close()
    finally:
        for element_id in list(holds._holds):
            holds.release(element_id)
        srv.stop()


@pytest.fixture
def short_runtime():
    """A runtime directory short enough for AF_UNIX.

    pytest's tmp_path embeds the test name, and a unix socket path is capped at
    ~108 bytes — a limit these test names comfortably exceed.
    """
    directory = tempfile.mkdtemp(prefix="dsk-")
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# --- Digest-keyed daemon socket ------------------------------------------- #


def test_daemon_socket_path_carries_the_schema_digest(tmp_path, monkeypatch):
    """A client and a daemon built from the same protocol agree on one socket.

    The name embeds the schema digest so that a client whose generated protocol
    differs finds no socket at all and starts its own. Within one build the name
    is stable, which is what lets several clients share one desktop.
    """
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    path = daemon_socket_path()
    assert SCHEMA_DIGEST in os.path.basename(path)
    assert os.path.basename(path).startswith(f"{DAEMON_SESSION}-")
    assert os.path.basename(path).endswith(".sock")


def test_connection_count_tracks_live_connections(server):
    """The drain monitor polls this to decide when to exit."""
    assert server.connection_count == 0
    conn_a, stream_a = rpc_client(server.socket_path)
    try:
        # The accept loop runs on its own thread, so there is a brief window
        # between connect() returning and the server registering the conn.
        _wait_until(lambda: server.connection_count == 1)
        conn_b, stream_b = rpc_client(server.socket_path)
        try:
            _wait_until(lambda: server.connection_count == 2)
        finally:
            stream_b.close()
            conn_b.close()
        _wait_until(lambda: server.connection_count == 1)
    finally:
        stream_a.close()
        conn_a.close()


def test_drain_monitor_exits_after_idle(tmp_path):
    """A daemon that served clients and then went idle exits on its own.

    Not killed — a write may be mid-flight. The monitor waits for connections to
    drain, then signals stop after the idle window.
    """
    import threading

    from desktop_service import server

    srv = JsonRpcServer(str(tmp_path / "drain.sock"))
    srv.register("echo", lambda params: {"echoed": params})
    srv.start()
    stop = threading.Event()

    # Shrink the timers so the test is fast.
    original_idle = server.DAEMON_DRAIN_IDLE_SECS
    original_poll = server.DAEMON_POLL_SECS
    original_grace = server.DAEMON_STARTUP_GRACE_SECS
    server.DAEMON_DRAIN_IDLE_SECS = 0.5
    server.DAEMON_POLL_SECS = 0.1
    server.DAEMON_STARTUP_GRACE_SECS = 1
    try:
        server._start_drain_monitor(srv, stop)

        # Connect, exchange, disconnect — then the daemon should self-exit.
        conn, stream = rpc_client(srv.socket_path)
        try:
            send(stream, "echo", {"x": 1})
            # Hold the connection long enough for the monitor to see it before
            # it disconnects — otherwise ever_connected is never set.
            time.sleep(0.3)
        finally:
            stream.close()
            conn.close()

        assert stop.wait(5), "daemon did not exit after clients drained"
    finally:
        server.DAEMON_DRAIN_IDLE_SECS = original_idle
        server.DAEMON_POLL_SECS = original_poll
        server.DAEMON_STARTUP_GRACE_SECS = original_grace
        srv.stop()


def test_drain_monitor_exits_when_no_client_connects(tmp_path):
    """A daemon nobody wanted exits after the startup grace."""
    import threading

    from desktop_service import server

    srv = JsonRpcServer(str(tmp_path / "unwanted.sock"))
    srv.start()
    stop = threading.Event()

    original_grace = server.DAEMON_STARTUP_GRACE_SECS
    original_poll = server.DAEMON_POLL_SECS
    server.DAEMON_STARTUP_GRACE_SECS = 0.5
    server.DAEMON_POLL_SECS = 0.1
    try:
        server._start_drain_monitor(srv, stop)
        assert stop.wait(5), "daemon did not exit when no client ever connected"
    finally:
        server.DAEMON_STARTUP_GRACE_SECS = original_grace
        server.DAEMON_POLL_SECS = original_poll
        srv.stop()


def test_a_dead_daemon_s_socket_is_swept_and_a_live_one_is_left_alone(short_runtime, monkeypatch):
    """Digest keying costs the old self-healing, so the sweep pays it back.

    One fixed name used to clean itself up: whoever booted next wanted that
    exact path and reclaimed it. Every schema change now mints a new name, so a
    daemon that was killed rather than stopped leaves a file no future daemon
    will ever ask for. Without a sweep the runtime directory accumulates one
    corpse per build that ever died badly.

    The distinction that matters is dead versus busy, and presence cannot tell
    them apart — a crashed daemon's socket file looks exactly like a working
    one. Only the connection attempt does.
    """
    monkeypatch.setenv("XDG_RUNTIME_DIR", short_runtime)
    directory = Path(default_socket_path("ignored")).parent

    # A daemon from an older build that crashed: the file outlived the process.
    corpse = directory / f"{DAEMON_SESSION}-0ldd1g3st.sock"
    dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    dead.bind(str(corpse))
    dead.close()
    assert corpse.exists()

    # A daemon from another build that is still serving somebody.
    live = JsonRpcServer(str(directory / f"{DAEMON_SESSION}-l1v3d1g3st.sock"))
    live.start()

    # And a file that is not a daemon socket at all.
    bystander = directory / "session-name.sock"
    bystander.write_text("")

    mine = directory / f"{DAEMON_SESSION}-{SCHEMA_DIGEST}.sock"
    try:
        removed = sweep_dead_daemon_sockets(keep=str(mine))
        assert removed == [str(corpse)]
        assert not corpse.exists(), "the corpse was left to accumulate"
        assert Path(live.socket_path).exists(), "a daemon still serving clients was swept"
        assert bystander.exists(), "the sweep reached past the daemon sockets"
    finally:
        live.stop()


def test_the_sweep_never_removes_the_socket_the_caller_is_serving_on(short_runtime, monkeypatch):
    """The listening socket answers, but a daemon must not depend on that.

    The sweep runs on a daemon's own startup, and the ordering that makes it
    safe — bind first, then sweep — is the kind of thing a later refactor
    reorders without noticing. Excluding the path explicitly means the mistake
    costs nothing.
    """
    monkeypatch.setenv("XDG_RUNTIME_DIR", short_runtime)
    directory = Path(default_socket_path("ignored")).parent
    mine = directory / f"{DAEMON_SESSION}-{SCHEMA_DIGEST}.sock"
    stray = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stray.bind(str(mine))
    stray.close()  # bound but nothing listening: indistinguishable from a corpse

    assert sweep_dead_daemon_sockets(keep=str(mine)) == []
    assert mine.exists(), "a daemon swept the socket it was about to serve on"
