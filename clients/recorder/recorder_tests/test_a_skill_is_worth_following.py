"""Does the route, kept, actually save the next session anything?

A store that keeps skills is easy to write and easy to fool yourself about. The
claim being made is not that a file was created — it is that an agent starting
cold, holding the skill, gets to the thing it is looking for, and gets there by
touching a fraction of the tree the first agent had to walk.

So the tree here is the one from the failure that prompted all this, rebuilt to
the anatomy that was actually verified: a `Direct Messages` list of forty-five
rows, every row with an empty accessible name, each row's identity three levels
down on a link, and the display name written in mathematical-bold codepoints
that an exact match does not match. An agent read that list at the level of the
rows, found nothing, and said the conversation did not exist — while it sat
first in the list.

Two things are measured against that tree. Whether the naive read still fails
(it does, and it must, or the skill is warning about nothing), and how many
nodes each approach has to look at. A node inspected is a probe call on a real
desktop, which is what the cost of not having a skill is actually made of.
"""

from __future__ import annotations

import unicodedata

from episode_recorder import Anchor, Derivation

#: `𝐜𝐨𝐨𝐤𝐢𝐞`, as Discord renders it. A different string from the letters it
#: looks like, which is the whole trap.
STYLIZED = "\U0001d41c\U0001d428\U0001d428\U0001d424\U0001d422\U0001d41e"

APPLICATION = "Discord"
TASK = "find a direct message by person"


def row(name: str, handle: str) -> dict:
    """One conversation, shaped the way the tree really is.

    The row itself is anonymous. The avatar knows the account handle, the link
    two levels down knows the display name, and nothing at the level a list is
    normally read at knows anything at all.
    """
    return {
        "role": "list item",
        "name": "",
        "children": [
            {"role": "image", "name": f"{handle}, Offline", "children": []},
            {
                "role": "section",
                "name": "",
                "children": [
                    {"role": "link", "name": f"{name} (direct message)", "children": []}
                ],
            },
        ],
    }


def desktop(rows: int = 45) -> dict:
    others = [row(f"person {n}", f"person_{n}") for n in range(1, rows)]
    return {
        "role": "frame",
        "name": "Discord",
        "children": [
            {"role": "list", "name": "Servers", "children": []},
            {
                "role": "list",
                "name": "Direct Messages",
                "children": [row(STYLIZED, "smh_wookie"), *others],
            },
        ],
    }


class Walk:
    """A reader of the tree that counts what it had to look at."""

    def __init__(self, tree: dict) -> None:
        self.tree = tree
        self.visits = 0

    def _seen(self, node: dict) -> dict:
        self.visits += 1
        return node

    def everything(self) -> int:
        """What deriving the route from nothing costs: the whole tree."""
        def descend(node):
            self._seen(node)
            for child in node["children"]:
                descend(child)

        descend(self.tree)
        return self.visits

    def naively(self, wanted: str) -> dict | None:
        """Read the list the way it is normally read: names, at row level."""
        for node in self.tree["children"]:
            self._seen(node)
            if node["name"] != "Direct Messages":
                continue
            for candidate in node["children"]:
                self._seen(candidate)
                if wanted in candidate["name"]:
                    return candidate
        return None

    def following(self, waypoints, wanted: str) -> dict | None:
        """Descend by the route, and fold before matching, because it says to."""
        found = self._seen(self.tree)
        for waypoint in waypoints[1:]:
            found = self._descend(found, waypoint, wanted)
            if found is None:
                return None
        return found

    def _descend(self, node, waypoint, wanted):
        """The next waypoint, looked for among descendants rather than children.

        The route names four elements and the tree has five levels: a step of a
        route is the next thing that matters, not the next thing that exists.
        That is what the skill's own warning is about — the identity is below
        the row, not on it — so a reader that only ever looked at direct
        children would reproduce the original failure while holding the answer.
        """
        for child in node["children"]:
            self._seen(child)
            if child["role"] == waypoint.role and self._matches(child, waypoint, wanted):
                return child
        for child in node["children"]:
            below = self._descend(child, waypoint, wanted)
            if below is not None:
                return below
        return None

    def _matches(self, node, waypoint, wanted) -> bool:
        if waypoint.name:
            return node["name"] == waypoint.name
        if waypoint.varies:
            return _fold(wanted) in _fold(node["name"])
        return not node["name"]


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def derived(person: str) -> Derivation:
    return Derivation(
        application=APPLICATION,
        task=TASK,
        version="1.0.151",
        anchors=(
            Anchor("frame", "Discord"),
            Anchor("list", "Direct Messages", siblings=2),
            Anchor("list item", "", siblings=45),
            Anchor("link", person),
        ),
        bound=(person,),
    )


def test_the_read_that_failed_still_fails(library):
    """If the naive read worked, the skill would be warning about nothing."""
    walk = Walk(desktop())
    assert walk.naively("cookie") is None
    assert walk.naively(STYLIZED) is None


def test_a_session_holding_the_skill_finds_what_the_first_one_missed(library):
    library.derive(derived(STYLIZED))
    skill = library.derive(derived("Tyler Barnes")).skill

    guided = Walk(desktop())
    found = guided.following(skill.waypoints, "cookie")

    assert found is not None, "the route led to the row the naive read walked past"
    assert found["role"] == "link"
    # Asked for in plain letters, found under a name written in bold ones,
    # because the skill says to fold before comparing.
    assert STYLIZED in found["name"]


def test_following_the_route_costs_a_fraction_of_deriving_it(library):
    library.derive(derived(STYLIZED))
    skill = library.derive(derived("Tyler Barnes")).skill

    derivation = Walk(desktop()).everything()
    guided = Walk(desktop())
    guided.following(skill.waypoints, "cookie")

    assert guided.visits * 10 < derivation, (
        f"following the route touched {guided.visits} nodes;"
        f" deriving it touched {derivation}"
    )
