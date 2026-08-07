"""A rejection must not echo the rejected value into the message.

The audit log records what was done and how it went, never what was said.
A validation rejection is the one place caller-supplied text used to reach
the log — it flowed into the problem message, which became the InvalidParams
reason, which became ``record.reason`` in the audit.  That path is closed now:
enum and pattern violations report the value's *type*, not the value itself,
matching the convention maxLength already followed.
"""

from desktop_service.validate import _check


def _problems(value, node) -> list[str]:
    problems: list[str] = []
    _check(value, node, "field", problems)
    return problems


def test_enum_rejection_reports_type_not_value() -> None:
    problems = _problems("green", {"type": "string", "enum": ["red", "blue"]})
    assert len(problems) == 1
    assert "str" in problems[0]
    assert "green" not in problems[0]


def test_pattern_rejection_reports_type_not_value() -> None:
    problems = _problems("bad!", {"type": "string", "pattern": r"^[a-z]+$"})
    assert len(problems) == 1
    assert "str" in problems[0]
    assert "bad!" not in problems[0]


def test_maxlength_rejection_reports_length_only() -> None:
    long_value = "x" * 50
    problems = _problems(long_value, {"type": "string", "maxLength": 8})
    assert len(problems) == 1
    assert long_value not in problems[0]
    assert "50" in problems[0]  # length reported, not the value


def test_sensitive_value_never_reaches_reason() -> None:
    """A secret-looking value rejected by an enum must not appear in the message."""
    secret = "supersecret-password-123"
    problems = _problems(secret, {"type": "string", "enum": ["red", "blue"]})
    assert len(problems) == 1
    assert secret not in problems[0]
    assert "supersecret" not in problems[0]
