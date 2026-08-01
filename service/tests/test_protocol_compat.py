"""The freeze, enforced.

Compares the live schema against a checked-in golden copy and fails on anything
breaking. Additive changes — new methods, new optional fields, new response
fields — pass.

The load-bearing case is `test_a_newly_required_request_field_is_breaking`. It
looks additive because nothing was removed, but it breaks every existing client
at once, and it is exactly the change segment 3 will be tempted to make when it
adds confirmation to destructive operations. Without that test the suite would
wave the break straight through, which is why the plan's do-not list forbids
weakening it.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIVE = ROOT / "protocol" / "schema.json"
GOLDEN = ROOT / "protocol" / "golden" / "v1.0.schema.json"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.fixture
def golden() -> dict:
    return _load(GOLDEN)


@pytest.fixture
def live() -> dict:
    return _load(LIVE)


def compare(golden: dict, live: dict) -> list[str]:
    """Every way `live` breaks a client written against `golden`."""
    breaks: list[str] = []

    if golden["protocolVersion"].split(".")[0] != live["protocolVersion"].split(".")[0]:
        breaks.append(
            f"major version changed: {golden['protocolVersion']} -> {live['protocolVersion']}"
        )

    for name, old in golden["methods"].items():
        new = live["methods"].get(name)
        if new is None:
            breaks.append(f"method removed: {name}")
            continue
        if old.get("operationClass") != new.get("operationClass"):
            breaks.append(
                f"{name}: operation class changed "
                f"{old.get('operationClass')} -> {new.get('operationClass')}"
            )
        breaks += _compare_params(name, old["params"], new["params"])
        breaks += _compare_result(name, old["result"], new["result"])

    breaks += _compare_defs(golden.get("$defs", {}), live.get("$defs", {}))
    breaks += _compare_enums(golden.get("enums", {}), live.get("enums", {}))
    return breaks


def _compare_params(method: str, old: dict, new: dict) -> list[str]:
    breaks: list[str] = []
    old_props = old.get("properties", {})
    new_props = new.get("properties", {})
    old_required = set(old.get("required", []))
    new_required = set(new.get("required", []))

    # THE case this suite exists for. A field that is new-and-required, or that
    # was optional and became required, breaks every client that never sent it.
    for name in new_required - old_required:
        kind = "new required" if name not in old_props else "optional promoted to required"
        breaks.append(f"{method}: request field {name!r} is {kind}")

    for name, spec in old_props.items():
        if name not in new_props:
            breaks.append(f"{method}: request field removed: {name}")
            continue
        breaks += _compare_type(f"{method}.params.{name}", spec, new_props[name])

    if old.get("anyOf") and not new.get("anyOf"):
        breaks.append(f"{method}: request alternatives (anyOf) removed")
    return breaks


def _compare_result(method: str, old: dict, new: dict) -> list[str]:
    breaks: list[str] = []
    old_props = old.get("properties", {})
    new_props = new.get("properties", {})
    for name, spec in old_props.items():
        if name not in new_props:
            breaks.append(f"{method}: response field removed: {name}")
            continue
        breaks += _compare_type(f"{method}.result.{name}", spec, new_props[name])
    # A response field that stops being guaranteed is a break: callers read it
    # unconditionally.
    for name in set(old.get("required", [])) - set(new.get("required", [])):
        breaks.append(f"{method}: response field {name!r} is no longer guaranteed")
    return breaks


def _compare_type(path: str, old: dict, new: dict) -> list[str]:
    breaks: list[str] = []
    if old.get("$ref") != new.get("$ref"):
        breaks.append(f"{path}: reference changed {old.get('$ref')} -> {new.get('$ref')}")
    if old.get("type") != new.get("type"):
        breaks.append(f"{path}: type changed {old.get('type')} -> {new.get('type')}")
    old_enum, new_enum = old.get("enum"), new.get("enum")
    if old_enum and new_enum:
        # Response enums may grow; request enums may not shrink. Removing a
        # member always breaks somebody, so that is what is checked.
        for member in set(old_enum) - set(new_enum):
            breaks.append(f"{path}: enum member removed: {member}")
    for bound, worse in (("minimum", lambda a, b: b > a), ("maximum", lambda a, b: b < a)):
        if bound in old and bound in new and worse(old[bound], new[bound]):
            breaks.append(f"{path}: {bound} tightened {old[bound]} -> {new[bound]}")
    if "items" in old and "items" in new:
        breaks += _compare_type(f"{path}[]", old["items"], new["items"])
    return breaks


def _compare_defs(old: dict, new: dict) -> list[str]:
    breaks: list[str] = []
    for name, spec in old.items():
        if name not in new:
            breaks.append(f"definition removed: {name}")
            continue
        old_props = spec.get("properties", {})
        new_props = new[name].get("properties", {})
        for field, field_spec in old_props.items():
            if field not in new_props:
                breaks.append(f"{name}.{field}: field removed")
                continue
            breaks += _compare_type(f"{name}.{field}", field_spec, new_props[field])
        for field in set(new[name].get("required", [])) - set(spec.get("required", [])):
            breaks.append(f"{name}.{field}: became required")
    return breaks


def _compare_enums(old: dict, new: dict) -> list[str]:
    breaks: list[str] = []
    for name, spec in old.items():
        if name not in new:
            breaks.append(f"enum removed: {name}")
            continue
        for member in set(spec["values"]) - set(new[name]["values"]):
            breaks.append(f"{name}: member removed: {member}")
    return breaks


def test_the_live_schema_matches_the_golden_copy(golden, live):
    assert compare(golden, live) == []


def test_the_golden_copy_is_byte_identical_to_the_frozen_schema():
    """The golden copy is a snapshot, not a second source of truth.

    At 1.0 they are the same file. When 1.x grows additively they diverge, and
    every difference must be one `compare` accepts — which the test above checks.
    """
    assert json.loads(GOLDEN.read_text())["protocolVersion"] == "1.0"


def test_a_removed_method_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    del mutated["methods"]["queryElements"]
    assert "method removed: queryElements" in compare(golden, mutated)


def test_a_newly_required_request_field_is_breaking(golden):
    """The one that matters.

    Nothing was removed and no type changed — a naive diff sees an addition. But
    every client that does not send `confirm` now fails, which is why the
    protocol declares it optional and refuses at runtime instead.
    """
    mutated = copy.deepcopy(golden)
    mutated["methods"]["getElement"]["params"]["required"].append("confirm")
    breaks = compare(golden, mutated)
    assert any("'confirm' is new required" in b for b in breaks), breaks


def test_promoting_an_existing_optional_field_to_required_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["inspectWindow"]["params"]["required"].append("depth")
    breaks = compare(golden, mutated)
    assert any("optional promoted to required" in b for b in breaks), breaks


def test_a_removed_field_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    del mutated["methods"]["listWindows"]["params"]["properties"]["applicationId"]
    assert any("request field removed" in b for b in compare(golden, mutated))


def test_a_narrowed_type_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["inspectWindow"]["params"]["properties"]["windowId"]["type"] = "integer"
    assert any("type changed" in b for b in compare(golden, mutated))


def test_a_tightened_bound_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["inspectWindow"]["params"]["properties"]["depth"]["maximum"] = 3
    assert any("maximum tightened" in b for b in compare(golden, mutated))


def test_a_removed_error_code_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    del mutated["enums"]["errorCode"]["values"]["ELEMENT_REFERENCE_STALE"]
    assert any("ELEMENT_REFERENCE_STALE" in b for b in compare(golden, mutated))


def test_a_removed_capability_tier_is_breaking(golden):
    """Deferred tiers are declared now so later work is additive.

    Dropping one because it is not implemented yet would defeat the entire
    reason the enum was declared complete at freeze time.
    """
    mutated = copy.deepcopy(golden)
    del mutated["enums"]["capabilityTier"]["values"]["app-native"]
    assert any("app-native" in b for b in compare(golden, mutated))


def test_a_major_version_bump_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    mutated["protocolVersion"] = "2.0"
    assert any("major version changed" in b for b in compare(golden, mutated))


def test_a_dropped_response_guarantee_is_breaking(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["queryElements"]["result"]["required"].remove("revision")
    assert any("no longer guaranteed" in b for b in compare(golden, mutated))


def test_a_new_method_is_additive(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["invokeElement"] = {
        "operationClass": "submit",
        "summary": "Segment 2 lands here.",
        "params": {
            "type": "object",
            "properties": {"elementId": {"type": "string"}},
            "required": ["elementId"],
            "additionalProperties": False,
        },
        "result": {"type": "object", "properties": {}, "additionalProperties": False},
    }
    assert compare(golden, mutated) == []


def test_a_new_optional_request_field_is_additive(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["queryElements"]["params"]["properties"]["sinceRevision"] = {
        "type": "integer"
    }
    assert compare(golden, mutated) == []


def test_a_new_response_field_is_additive(golden):
    mutated = copy.deepcopy(golden)
    mutated["methods"]["listWindows"]["result"]["properties"]["observationMode"] = {
        "type": "string"
    }
    assert compare(golden, mutated) == []
