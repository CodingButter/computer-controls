"""The header of a published skill, written and read without a YAML parser.

The Agent Skills specification puts a YAML block at the top of `SKILL.md`, and
the obvious way to produce one is to reach for a YAML library. This package does
not, for two reasons that point the same way.

The first is that nothing else here has a dependency. The service, the recorder
and this package run on what Python ships with, and a registry that needed a
package installed before it could read its own files would be a registry with a
prerequisite nobody wrote down.

The second is the one that matters. YAML will parse anything, which is exactly
the property this file does not want. Every value that goes into one of these
headers has already been through a shape check — a slug, a version, a date, a
count, or a description this package generated itself — so the writer here can
refuse to emit anything else, and the reader can refuse to accept anything else.
A header that cannot express a list, a multi-line string or an anchor is a
header that cannot smuggle one, and the subset it does express is the whole of
what a skill has to say about itself.
"""

from __future__ import annotations

import re

#: What separates the header from the instructions, per the specification.
FENCE = "---"

#: A key is an identifier in the header's own vocabulary, not something read
#: off a screen. Hyphens because the specification uses them.
KEY = re.compile(r"\A[a-z][a-z0-9-]*\Z")

#: A value is one line, and carries neither a double quote nor a backslash.
#: Refused rather than escaped: an escape is a way to say something the format
#: was built not to say, and nothing a skill legitimately holds needs one.
VALUE = re.compile(r'\A[^\n\r"\\]{0,1024}\Z')


class MalformedHeader(ValueError):
    """A header this package will not write, or will not trust having read."""


def dump(fields: dict[str, object]) -> str:
    """The header for a skill, from a mapping one level deep.

    A value may be a string, an integer, or a mapping of those — which is what
    `metadata` is, and the only nesting the specification asks for.
    """
    lines = [FENCE]
    for key, value in fields.items():
        _key(key)
        if isinstance(value, dict):
            lines.append(f"{key}:")
            for inner, held in value.items():
                _key(inner)
                lines.append(f"  {inner}: {_scalar(held)}")
        else:
            lines.append(f"{key}: {_scalar(value)}")
    lines.append(FENCE)
    return "\n".join(lines) + "\n"


def parse(text: str) -> tuple[dict[str, object], str]:
    """The header and the instructions, split.

    The split is enforced rather than assumed: a file with no header is not a
    skill with an empty one, it is a file this package did not write, and the
    difference is worth an exception. The SDK that consumes these makes the same
    split for the same reason — so that a header can never end up in the text an
    agent is handed as instructions.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != FENCE:
        raise MalformedHeader("a skill starts with a header, and this does not")
    try:
        end = lines.index(FENCE, 1)
    except ValueError:
        raise MalformedHeader("the header is opened and never closed") from None

    fields: dict[str, object] = {}
    holding: dict[str, object] | None = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        if line.startswith("  "):
            if holding is None:
                raise MalformedHeader(f"indented under nothing: {line!r}")
            key, value = _pair(line.strip())
            holding[key] = value
            continue
        key, value = _pair(line)
        if value == "":
            holding = {}
            fields[key] = holding
        else:
            fields[key] = value
            holding = None

    return fields, "\n".join(lines[end + 1:]).lstrip("\n")


def _pair(line: str) -> tuple[str, object]:
    if ":" not in line:
        raise MalformedHeader(f"not a header line: {line!r}")
    key, _, value = line.partition(":")
    key, value = key.strip(), value.strip()
    _key(key)
    # Nothing after the colon opens a mapping; `parse` reads the block under it.
    if value == "":
        return key, ""
    if value.startswith('"'):
        if not value.endswith('"') or len(value) < 2:
            raise MalformedHeader(f"a quoted value that never closes: {value!r}")
        value = value[1:-1]
        if not VALUE.fullmatch(value):
            raise MalformedHeader(f"not a value this header may carry: {value!r}")
        return key, value
    if not VALUE.fullmatch(value):
        raise MalformedHeader(f"not a value this header may carry: {value!r}")
    if value.lstrip("-").isdigit():
        return key, int(value)
    # An unquoted value that is not a count is a header this package did not
    # write. Refused rather than accepted as a string, because accepting it is
    # accepting whatever some other YAML reader decides it means — which is the
    # bug this quoting exists to close.
    raise MalformedHeader(
        f"an unquoted value that is not a count: {value!r}. Every string in a"
        " header written by this package is quoted, so that no reader has to"
        " guess whether it is a date, a version or a word."
    )


def _key(key: str) -> None:
    if not KEY.fullmatch(key):
        raise MalformedHeader(f"not a header key: {key!r}")


def _scalar(value: object) -> str:
    if isinstance(value, bool):
        raise MalformedHeader(
            "a header carries no flags: a skill that is true of nothing in"
            " particular is a skill nobody can act on"
        )
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str):
        raise MalformedHeader(f"not a value a header may carry: {value!r}")
    if not VALUE.fullmatch(value):
        raise MalformedHeader(
            f"not a value this header may carry: {value!r}. A header holds one"
            " line per fact, so that a fact cannot be hidden inside another,"
            " and it carries no quote or backslash to escape its way out of"
            " one."
        )
    # Quoted, always. These files are written by Python and read by a YAML
    # parser in another language, and a bare `2026-08-05` is a date to one of
    # them and a string to the other, while a bare `132.0` is a version to a
    # person and a float to both. A count is the only thing a reader may infer,
    # because it is the only thing this package means as a number.
    return f'"{value}"'
