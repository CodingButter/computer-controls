"""One route over HTTP, and no decisions of its own.

`POST /submissions` is the whole surface. Everything it does is read the bytes,
hand them to `Publisher.publish`, and turn the answer into JSON — so that the
screens are testable without a socket and a second transport, if one ever
appears, cannot disagree with this one about what publishes.

The status codes are the refusal, restated for a machine. `422` for a submission
that was screened and refused, because the request was understood and the answer
is no; `503` for the two cases where the fault is this service's — no credential,
or a forge that would not answer — because a contributor's client should retry
those and must not retry the others. The body is the same either way: the screens
that ran, each with its name and its sentence, so a page can render the reason
without parsing English out of a status line.

Nothing here reaches a machine. There is no route that names a session, an
element or a socket, and the only address this process knows is a repository's.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .publishing import Publisher
from .submission import MAX_BYTES, Refused

ROUTE = "/submissions"

#: What a screen means to a machine. Screens not named here are the submission's
#: own problem and answer `422`: the request was understood and the answer is no,
#: and a resubmission of the same skill gets the same answer. The two here are
#: worth telling apart — `credential` and `forge` are this service's fault and
#: are worth retrying, and `size` and `cap` are limits with a number in them.
STATUSES = {
    "credential": 503,
    "forge": 503,
    "size": 413,
    "cap": 429,
    "rate": 429,
}


def outcome(publisher: Publisher, body: bytes) -> tuple[int, dict[str, Any]]:
    """What this service answers, as a status and a document.

    Separated from the socket so the answer can be asserted without one.
    """
    try:
        published = publisher.publish(body)
    except Refused as refusal:
        # Ours before theirs when both apply. A submission refused for something
        # the contributor could fix *and* something only this service can must
        # not be reported as theirs to fix — they would go and edit a route that
        # was never the problem.
        named = [
            STATUSES[screen.name]
            for screen in refusal.screens
            if screen.name in STATUSES
        ]
        return next(iter(sorted(named, key=lambda code: code != 503)), 422), {
            "published": False,
            "refusals": [
                {"screen": screen.name, "because": screen.reason}
                for screen in refusal.screens
            ],
        }
    return 201, {
        "published": True,
        "skill": published.skill,
        "pullRequest": published.proposed,
        "credited": published.credited,
    }


def handler(publisher: Publisher) -> type[BaseHTTPRequestHandler]:
    class SubmissionHandler(BaseHTTPRequestHandler):
        server_version = "commons-service"
        sys_version = ""

        #: A connection that has stopped talking is dropped rather than held.
        #: Without this a client that declares a body and then goes quiet holds
        #: a thread until the process dies, and enough of them hold all of them
        #: — an outage anybody can cause from one socket, which is worse than
        #: anything the size limit above was guarding against.
        timeout = 30

        def do_POST(self) -> None:  # noqa: N802 - the name http.server calls
            if self.path.rstrip("/") != ROUTE:
                return self._answer(
                    404,
                    {
                        "published": False,
                        "refusals": [
                            {
                                "screen": "route",
                                "because": f"this service has one verb: POST"
                                f" {ROUTE}, which proposes one skill",
                            }
                        ],
                    },
                )

            # A length that is not a number is a refusal rather than a
            # traceback: `http.server` answers an exception out of a handler
            # with a 500 and a stack trace, which tells a contributor nothing
            # and tells everybody else which Python this is running.
            try:
                declared = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                declared = -1
            if declared < 0 or declared > MAX_BYTES:
                # Refused on the declared length rather than after reading it,
                # so that a body nobody is going to accept is not one this
                # process has to hold. The reason is still sent: a limit a
                # contributor is told about is one they can work inside.
                says = str(declared) if declared >= 0 else (
                    "a length this server cannot read"
                )
                return self._answer(
                    413,
                    {
                        "published": False,
                        "refusals": [
                            {
                                "screen": "size",
                                "because": "a submission is at most"
                                f" {MAX_BYTES} bytes and this one declares"
                                f" {says}",
                            }
                        ],
                    },
                )

            status, document = outcome(publisher, self.rfile.read(declared))
            self._answer(status, document)

        def _answer(self, status: int, document: dict[str, Any]) -> None:
            body = json.dumps(document, indent=2).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: Any) -> None:
            """Nothing, deliberately.

            The default writes every request line to stderr. A request line here
            is a submission, and a submission is somebody's route; the record
            that matters is the ledger, which writes screen names and never
            content, and a second log with different rules would undo it.
            """

    return SubmissionHandler


def serve(publisher: Publisher, *, host: str = "127.0.0.1", port: int = 0):
    """The server, unstarted, bound. The caller runs it and owns the thread."""
    return ThreadingHTTPServer((host, port), handler(publisher))
