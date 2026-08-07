"""The requests this machine makes, and the header it never sends.

Both user-side verbs talk to something over HTTP — publish to the project's own
service, fetch to the public folder the commons is — and neither one
authenticates. That is the property worth having in one file rather than two:
there is exactly one function here that opens a connection, it takes a request
somebody else built, and there is nowhere in it to reach for a token.

`urllib` rather than anything installed, because nothing else in this package
has a dependency and a commons you have to `pip install` something to read is a
commons with a prerequisite nobody wrote down. An HTTP error is answered as a
status and a body rather than raised, because a service refusing a submission is
telling the person something and the reason is in the body it refused with.
"""

from __future__ import annotations

import urllib.error
import urllib.request


def over_http(request: urllib.request.Request, timeout: float) -> tuple[int, str]:
    """Send one request and answer with what came back, refusals included."""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answered:
            return answered.status, answered.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as refused:
        return refused.code, refused.read().decode("utf-8", "replace")
