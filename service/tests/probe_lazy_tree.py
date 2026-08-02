"""Characterise what a Chromium-family window actually exposes, and when.

Not a test: a recorded investigation whose conclusion goes into
docs/07-open-questions.md. Run from the service directory.
"""

import sys
import time

from desktop_service.backends import atspi, loop


def role_of(node, index=0):
    element, _fingerprint, _reference = atspi.describe(node, index, "")
    return element.role


def shape(window, label):
    """Node count and the roles one level down, which is where the gap shows."""
    total = [0]
    roles = []

    def walk(node, depth):
        total[0] += 1
        if depth == 1:
            roles.append(role_of(node))
        if depth >= 6:
            return
        for child in atspi.children_of(node):
            walk(child, depth + 1)

    walk(window, 0)
    print(f"{label}: nodes={total[0]} children={len(roles)} roles={roles[:8]}")
    return total[0]


def main():
    loop.get_loop().start()

    for name in ("vesktop", "Google Chrome"):
        listed = loop.call_on_loop(atspi.list_applications, timeout=10.0)
        match = next((a for a in listed if a["name"] == name), None)
        if match is None:
            print(f"{name}: not running")
            continue
        app = loop.call_on_loop(lambda i=match["id"]: atspi.find_application(i), timeout=10.0)
        if app is None:
            print(f"{name}: listed but not reachable")
            continue
        windows = loop.call_on_loop(lambda a=app: atspi.children_of(a), timeout=10.0)
        for window in windows:
            role = loop.call_on_loop(lambda w=window: role_of(w), timeout=10.0)
            if role not in {"frame", "window", "dialog"}:
                continue
            first = loop.call_on_loop(lambda w=window: shape(w, f"{name} t0"), timeout=20.0)
            # The hypothesis: the tree is built lazily once an assistive client
            # has been watching for a moment. If it is true, the second read is
            # bigger than the first with nothing else having changed.
            time.sleep(3.0)
            second = loop.call_on_loop(lambda w=window: shape(w, f"{name} t+3s"), timeout=20.0)
            print(f"{name}: grew={second > first} ({first} -> {second})")
            break

    loop.get_loop().stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
