"""Validate requests against the frozen protocol schema.

A deliberately small JSON Schema subset — exactly the constructs `protocol/schema.json`
uses. It refuses to guess: an unrecognised construct raises rather than passing
silently, so a schema feature added without validator support fails loudly at
test time instead of letting malformed requests through in production.

This is not a message shape. Shapes live only in the generated module; this is the
mechanism that enforces them.
"""

from __future__ import annotations

from typing import Any

from .errors import InvalidParams
from .protocol_generated import DEFS, PARAMS_SCHEMA

_TYPES: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "boolean": bool,
    "object": dict,
    "array": list,
    "null": type(None),
}


class SchemaFeatureUnsupported(RuntimeError):
    """The schema uses something this validator does not implement."""


def validate_params(method: str, params: Any) -> dict[str, Any]:
    """Check a request's params, returning them, or raise InvalidParams."""
    schema = PARAMS_SCHEMA.get(method)
    if schema is None:
        return params if isinstance(params, dict) else {}
    if params is None:
        params = {}
    problems: list[str] = []
    _check(params, schema, "params", problems)
    if problems:
        raise InvalidParams(
            f"{method}: {problems[0]}",
            detail={"method": method, "violations": problems},
        )
    return params


def _resolve(node: dict[str, Any]) -> dict[str, Any]:
    ref = node.get("$ref")
    if ref is None:
        return node
    if not ref.startswith("#/$defs/"):
        raise SchemaFeatureUnsupported(f"unsupported $ref: {ref}")
    return DEFS[ref[len("#/$defs/") :]]


def _check(value: Any, node: dict[str, Any], path: str, problems: list[str]) -> None:
    node = _resolve(node)

    if "anyOf" in node:
        # Used for "at least one filter" — report the whole requirement rather
        # than the first branch's complaint, which would be misleading.
        branches: list[list[str]] = []
        for branch in node["anyOf"]:
            found: list[str] = []
            _check(value, {**{k: v for k, v in node.items() if k != "anyOf"}, **branch}, path, found)
            if not found:
                return
            branches.append(found)
        problems.append(
            f"{path} satisfied none of the alternatives: "
            + "; ".join(b[0] for b in branches)
        )
        return

    expected = node.get("type")
    if expected is not None and not _type_ok(value, expected):
        problems.append(f"{path} must be {expected}, got {type(value).__name__}")
        return

    if "enum" in node and value not in node["enum"]:
        problems.append(f"{path} must be one of {node['enum']}, got {value!r}")
        return

    if isinstance(value, dict):
        _check_object(value, node, path, problems)
    elif isinstance(value, list):
        _check_array(value, node, path, problems)
    elif isinstance(value, int) and not isinstance(value, bool):
        _check_number(value, node, path, problems)


def _type_ok(value: Any, expected: Any) -> bool:
    if isinstance(expected, list):
        return any(_type_ok(value, one) for one in expected)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "string":
        # bool is not an int here and str is not a number anywhere.
        return isinstance(value, str)
    known = _TYPES.get(expected)
    if known is None:
        raise SchemaFeatureUnsupported(f"unsupported type: {expected}")
    return isinstance(value, known)


def _check_object(value: dict, node: dict[str, Any], path: str, problems: list[str]) -> None:
    properties = node.get("properties", {})
    for name in node.get("required", []):
        if name not in value:
            problems.append(f"{path}.{name} is required")
    if node.get("additionalProperties") is False:
        for name in value:
            if name not in properties:
                problems.append(f"{path}.{name} is not a known field")
    for name, child in value.items():
        if name in properties:
            _check(child, properties[name], f"{path}.{name}", problems)


def _check_array(value: list, node: dict[str, Any], path: str, problems: list[str]) -> None:
    items = node.get("items")
    if items is None:
        return
    for index, child in enumerate(value):
        _check(child, items, f"{path}[{index}]", problems)


def _check_number(value: int, node: dict[str, Any], path: str, problems: list[str]) -> None:
    minimum = node.get("minimum")
    maximum = node.get("maximum")
    if minimum is not None and value < minimum:
        problems.append(f"{path} must be >= {minimum}, got {value}")
    if maximum is not None and value > maximum:
        problems.append(f"{path} must be <= {maximum}, got {value}")
