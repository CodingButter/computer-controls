"""The desktop as files, so that a git diff is the delta.

A commit's diff has to *be* what changed, not a note about what changed. That
only works if the desktop is spread out as files: a window is a file, an element
is a file, focus is a file. Applying a delta means editing exactly the files the
delta named, so ``git show`` on an action renders the semantic change with no
help from this program.

The changes applied here come from the service's own diff engine, arriving on
the action result the client already received. There is no second look at the
desktop — a recorder that re-inspected could disagree with the delta the agent
was told about, and then the episode would be a record of a desktop nobody saw.

That the engine says how a value changed but never what it changed to is not a
gap to fill in. `state.diff` reports "grew by four characters at the end"
because the content is precisely what the value-egress point exists to withhold.
The tree therefore records the account the service gave, and an episode is a
record of the work rather than a transcript of the screen.

Two allowlists do the withholding, and they are allowlists rather than
denylists on purpose: a field nobody thought about is dropped instead of
written. Between them they are why no pixel coordinate can be recorded — not
because coordinates are filtered, but because no path exists for one to arrive
on. Coordinates do not travel; semantics do.
"""

from __future__ import annotations

import json
from typing import Any

#: What may be copied out of one change. `detail` is deliberately absent: it is
#: an open object, which is another way of saying nobody can promise what is in
#: it, and this is a file that gets committed forever.
CHANGE_FIELDS = (
    "kind",
    "revision",
    "attribution",
    "applicationId",
    "applicationName",
    "windowId",
    "elementId",
    "summary",
)

#: What a materialised window or element file may say about itself.
SUBJECT_FIELDS = (
    "applicationId",
    "applicationName",
    "windowId",
    "elementId",
)

WINDOWS = "desktop/windows"
ELEMENTS = "desktop/elements"
FOCUS = "desktop/focus"


def carried(change: dict[str, Any]) -> dict[str, Any]:
    """One change, reduced to the fields an episode is allowed to keep."""
    return {key: change[key] for key in CHANGE_FIELDS if key in change}


def _document(change: dict[str, Any]) -> dict[str, Any]:
    subject = {key: change[key] for key in SUBJECT_FIELDS if change.get(key)}
    subject["lastChange"] = {
        key: change[key] for key in ("kind", "revision", "summary") if key in change
    }
    return subject


def _rendered(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True) + "\n"


def window_path(window_id: str) -> str:
    return f"{WINDOWS}/{window_id}.json"


def element_path(element_id: str) -> str:
    return f"{ELEMENTS}/{element_id}.json"


class DesktopTree:
    """The materialised desktop, applied to a store's working tree."""

    def __init__(self, store) -> None:
        self._store = store

    def apply(self, changes: list[dict[str, Any]]) -> None:
        for change in changes:
            self._apply_one(change)

    def _apply_one(self, change: dict[str, Any]) -> None:
        kind = change.get("kind")
        window_id = change.get("windowId")
        element_id = change.get("elementId")

        if kind == "window-opened" and window_id:
            self._store.write(window_path(window_id), _rendered(_document(change)))
        elif kind == "window-closed" and window_id:
            self._store.remove(window_path(window_id))
            self._forget_elements_of(window_id)
        elif kind == "focus-changed":
            self._store.write(FOCUS, self._focus_line(change))
        elif kind == "element-disappeared" and element_id:
            self._store.remove(element_path(element_id))
        elif element_id:
            # Everything else that names an element is a change to what that
            # element is: it appeared, its value moved, a state flipped, or the
            # service can no longer vouch for it. An element first heard of
            # mid-episode is written rather than dropped, because an episode
            # that starts on a desktop already in use is the normal case.
            self._store.write(element_path(element_id), _rendered(self._merged(change)))

    def _merged(self, change: dict[str, Any]) -> dict[str, Any]:
        """A change folded onto whatever the file already said.

        An `element-value-changed` names the element and its application but not
        the window it lives in; the file already knows. Merging keeps a later,
        thinner change from erasing what an earlier, fuller one established.
        """
        existing = self._read(element_path(change["elementId"]))
        document = _document(change)
        merged = {key: value for key, value in existing.items() if key != "lastChange"}
        merged.update(document)
        return merged

    def _read(self, relative: str) -> dict[str, Any]:
        target = self._store.path / relative
        if not target.exists():
            return {}
        return json.loads(target.read_text())

    def _focus_line(self, change: dict[str, Any]) -> str:
        window_id = change.get("windowId")
        if not window_id:
            return "nothing\n"
        return f"{window_id}\n"

    def _forget_elements_of(self, window_id: str) -> None:
        """A closed window takes its elements with it.

        The delta engine announces the window and stops; it does not itemise
        the elements that went with it. Leaving them in the tree would leave the
        episode claiming a desktop where elements outlive their windows.
        """
        directory = self._store.path / ELEMENTS
        if not directory.is_dir():
            return
        for path in sorted(directory.glob("*.json")):
            document = json.loads(path.read_text())
            if document.get("windowId") == window_id:
                self._store.remove(f"{ELEMENTS}/{path.name}")
