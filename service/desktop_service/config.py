"""What the user decided, read from a file the user owns.

The ceiling on what any client may do has to come from somewhere no client can
reach. That is the whole reason this is a file on disk rather than a method on
the protocol: a permission a caller can raise is not a permission.

The file is optional and its absence is the safe answer, not an error. A
service that refused to start without a config would get one written in a hurry
by whoever was trying to get their agent working, and it would say yes to
everything. A service that starts read-only is a service somebody configures
deliberately, once they hit the wall on purpose.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def default_path() -> Path:
    """Config, following the convention the socket and the log already follow."""
    home = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(home) / "mastracode-desktop" / "config.json"


def load(path: Path | str | None = None) -> dict[str, Any]:
    """Read the configuration, or return the safe defaults.

    A malformed file is not treated as an empty one. Silently falling back to
    defaults when a user's carefully written allowlist has a trailing comma
    would hand back a service that ignores the thing it was told — quietly, and
    in the safe direction, which is exactly how nobody notices for a month.
    """
    location = Path(path) if path else default_path()
    if not location.exists():
        return {}
    text = location.read_text(encoding="utf-8")
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"{location} is not valid JSON: {error}") from error
    if not isinstance(loaded, dict):
        raise ValueError(f"{location} must contain a JSON object")
    return loaded


#: A commented example, written next to the code that reads it so the two
#: cannot drift. Every key here is optional and every default is the cautious
#: one.
EXAMPLE = {
    "scopes": {
        "operationClasses": ["observe", "edit", "activate"],
        "applications": [],
        "blockedApplications": ["bitwarden", "keepassxc"],
        "confirmClasses": ["submit", "destructive"],
        "idleExpirySeconds": 1800,
    },
    "sensitiveApplications": [],
    "audit": True,
}
