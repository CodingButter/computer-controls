"""Recording is a client, and this is the file that keeps it one.

The issue's last acceptance criterion is a negative one: `service/` gains no
method for recording. Negatives rot quietly — nothing fails when somebody
reaches across, it just becomes normal — so the boundary is asserted here
rather than described in a README.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SERVICE = REPO / "service" / "desktop_service"
RECORDER = REPO / "clients" / "recorder" / "episode_recorder"


def test_the_protocol_gained_no_method_for_recording():
    """The contract is frozen at v1.0, and an episode store did not thaw it."""
    live = json.loads((REPO / "protocol" / "schema.json").read_text())
    golden = json.loads((REPO / "protocol" / "golden" / "v1.0.schema.json").read_text())

    # The freeze permits growth, not removal, and the service's own
    # compatibility test polices that. What this test adds is narrower: this
    # change grew the contract by nothing at all.
    assert set(golden["methods"]) <= set(live["methods"])
    # The recorder is built entirely out of what a client already gets back.
    assert not [name for name in live["methods"] if "episode" in name.lower()]
    assert not [name for name in live["methods"] if "record" in name.lower()]


def test_no_module_under_service_knows_the_recorder_exists():
    for path in SERVICE.rglob("*.py"):
        source = path.read_text()
        assert "episode_recorder" not in source, f"{path.name} imports the recorder"
        assert "EpisodeStore" not in source, f"{path.name} names the recorder"


def test_the_recorder_is_reachable_without_the_service_installed():
    """Its own modules import nothing from `desktop_service`.

    The tests import the service on purpose — they drive the real diff engine,
    because a recorder proved against a hand-rolled fake would only prove the
    fake. The package itself must not, or the client would be a second half of
    the daemon rather than a consumer of it.
    """
    for path in RECORDER.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                assert not name.startswith("desktop_service"), f"{path.name} imports {name}"


def test_the_recorder_carries_no_dependency_of_its_own():
    """Standard library and git. A store you cannot open is not a record."""
    allowed = {
        "__future__", "ast", "collections", "contextlib", "dataclasses", "datetime",
        "hashlib", "json", "os", "pathlib", "re", "secrets", "shutil", "subprocess",
        "typing", "unicodedata",
    }
    for path in RECORDER.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:  # a sibling module in this package
                    continue
                roots = [(node.module or "").split(".")[0]]
            else:
                continue
            for root in roots:
                assert root in allowed or root == "episode_recorder", (
                    f"{path.name} imports {root}, which is neither stdlib nor this package"
                )
