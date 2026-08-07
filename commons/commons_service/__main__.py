"""Run the service: `python -m commons_service`.

The four things a deployment has to say are the four things read here — which
repository proposals are opened against, which checkout to open them from, which
branch to cut from, and where to listen. The credential is not one of them: it is
in the environment as `COMMONS_GITHUB_TOKEN`, where `gh` already looks for it, so
that it is never an argument in a process list or a line in a shell history.

The posting account is whoever that token belongs to, and it is the same account
for every submission. That is the whole point of this process existing: a
contributor needs no GitHub account, no token and no git, because this one has
them.

Refuses to start without a credential rather than starting and refusing every
submission — a service that boots into a state where nothing can work is a page of
confusing errors for whoever is trying to use it. That check is at boot *as well
as* at every publish, not instead of it: a token that was there when this started
is not a token the forge will still accept an hour from now.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from skill_commons.curation import Ledger
from skill_commons.forge import GitHubForge

from .publishing import Publisher, publish_disabled
from .server import ROUTE, serve


def main(argv: list[str] | None = None) -> int:
    parsed = _arguments(argv)

    disabled = publish_disabled()
    if disabled:
        print(disabled, file=sys.stderr)
        return 2

    def forges(submitter: str) -> GitHubForge:
        # One forge per installation, all of them posting as this process's
        # account. The submitter varies because the cap is per installation and
        # the forge finds its own proposals by the trailer; the credential does
        # not vary, because there is one.
        return GitHubForge(
            repo=parsed.repo,
            checkout=Path(parsed.checkout),
            submitter=submitter,
        )

    publisher = Publisher(
        forges,
        ledger=Ledger(parsed.ledger),
        base=parsed.base,
    )
    httpd = serve(publisher, host=parsed.host, port=parsed.port)
    host, port = httpd.server_address[:2]
    print(f"proposing to {parsed.repo} — POST http://{host}:{port}{ROUTE}")
    httpd.serve_forever()
    return 0


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="commons-service", description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name of the commons")
    parser.add_argument(
        "--checkout", required=True, help="a working copy of that repository"
    )
    parser.add_argument("--base", default="main")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8781)
    parser.add_argument(
        "--ledger",
        default=os.path.join(
            os.environ.get("XDG_STATE_HOME") or "/var/lib",
            "commons-service",
            "submissions.jsonl",
        ),
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
