"""Ask a running application's elements — not just its frames — what they can do.

Not a test: a recorded investigation whose conclusion goes into
docs/07-open-questions.md and docs/05-compatibility-matrix.md. It exists because
"this application exposes no actions" was once said on the strength of the frame
column alone, and there was nothing to run that would have contradicted it.

Run from the service directory, against whatever is on the bus:

    .venv/bin/python tests/probe_element_actions.py            # every application
    .venv/bin/python tests/probe_element_actions.py zoom       # one, by name
"""

import sys

from desktop_service import probe
from desktop_service.backends import atspi, loop


def main() -> int:
    wanted = {name.lower() for name in sys.argv[1:]}

    loop.get_loop().start()
    try:
        listed = loop.call_on_loop(atspi.list_applications, timeout=10.0)
        if wanted:
            listed = [app for app in listed if app["name"].lower() in wanted]
        if not listed:
            print("nothing matching is on the accessibility bus")
            return 1

        for app in listed:
            measured = loop.call_on_loop(
                lambda i=app["id"]: probe.probe_application(i), timeout=120.0
            )
            if measured is None:
                print(f"{app['name']}: listed but not reachable")
                continue
            row = measured.to_json()
            print(
                f"{row['name']}: windows={row['windowCount']} nodes={row['nodeCount']}"
                f" frameActions={row['frameActionCount']}"
                f" actionableElements={row['actionableElements']}"
            )
            for described in row["elementActions"]:
                print(f"    {described}")
            if row["actionableElements"] == 0 and row["nodeCount"] > 1:
                # The finding that would earn an escalation up the tier ladder:
                # a tree that can be read and cannot be driven.
                print("    nothing under the frame exposes an action")
    finally:
        loop.get_loop().stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
