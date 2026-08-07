"""The distribution ruling is a ruling, and this is the file that keeps it one.

The daemon behind the Unix socket is none of the things described in
`docs/06-how-a-stranger-connects.md`: not an account service, not a relay, not
a pairing authority. Those are layers that will sit above it, and when they
arrive they will be deliberate additions, not things that crept in one import at
a time. Negatives rot quietly — nothing fails when somebody adds a network
bind, it just becomes normal — so the boundary is asserted here rather than
described in a README.

The tests are structural: they read the protocol, the config, and the source
itself, and they fail loudly if any of them has grown a seam that belongs to a
layer the daemon is not. They run under `--no-live` because the claim is about
the shape of the repository, not about what is on screen.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

from desktop_service import config

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "comcon" / "desktop_service"

#: Words that name a distribution-layer concern, not a desktop-control one.
#: A method, a config key, or an import root carrying one of these is a seam
#: the daemon does not own. The list is short on purpose: it names components,
#: not every English word that could describe networking.
FORBIDDEN_FRAGMENTS = ("relay", "account", "pair", "tunnel", "discovery")


def test_the_protocol_gained_no_method_for_distribution():
    """The frozen v1.0 contract is a desktop-control contract, not a distribution one.

    A method named `pairDevice` or `openRelay` would mean the daemon had grown
    a surface for reaching across the network, which is the one thing
    `docs/06-how-a-stranger-connects.md` says the layers above it do, not it.
    """
    live = json.loads((REPO / "protocol" / "schema.json").read_text())
    for name in live["methods"]:
        lower = name.lower()
        assert not any(frag in lower for frag in FORBIDDEN_FRAGMENTS), (
            f"protocol method '{name}' names a distribution concern; "
            "the daemon does not own that layer"
        )


def _walk_keys(obj, prefix=""):
    """Yield every key in a nested document, so a claim about config covers nested scopes."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield f"{prefix}.{key}" if prefix else key
            yield from _walk_keys(value, f"{prefix}.{key}" if prefix else key)


def test_config_requires_no_cloud_endpoint():
    """The daemon starts and runs with no cloud configuration.

    `config.EXAMPLE` is the complete set of keys a user might write, and every
    default is the cautious one. A key referencing a relay, an account, or a
    remote endpoint would mean the daemon depends on infrastructure it does not
    control — the opposite of the 'no cloud-only configuration' constraint.
    """
    for key in _walk_keys(config.EXAMPLE):
        lower = key.lower()
        assert not any(frag in lower for frag in FORBIDDEN_FRAGMENTS), (
            f"config key '{key}' names a distribution concern; "
            "the daemon needs no cloud configuration"
        )


def test_no_service_module_imports_a_distribution_layer():
    """The daemon hosts no distribution component.

    An import of `relay` or `account_service` would mean the daemon had grown a
    dependency on a layer that sits above it. The import check is structural —
    it walks the AST of every module under `desktop_service/` — so it catches a
    seam before the code that uses it has been written. Every segment of every
    import path is checked, so ``from .relay import X`` (relative) and
    ``from desktop_service.relay import X`` (qualified absolute) are caught,
    not just bare ``import relay``.
    """
    sources = list(SERVICE.rglob("*.py"))
    assert sources, (
        f"no Python modules found under {SERVICE}; the import invariant "
        "cannot be checked — this is likely a path configuration error"
    )
    for path in sources:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    modules = [node.module]
                elif node.level:
                    # ``from . import relay`` — the name is a sibling module
                    modules = [alias.name for alias in node.names]
                else:
                    modules = []
            else:
                continue
            for module in modules:
                for segment in module.split("."):
                    lower = segment.lower()
                    assert not any(frag in lower for frag in FORBIDDEN_FRAGMENTS), (
                        f"{path.name} imports '{module}', which names a "
                        "distribution concern; the daemon hosts no such layer"
                    )
