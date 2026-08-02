"""What a password looks like on the way out, which is: nothing.

This module is the policy half of the value-egress point declared in `model`.
That point exists so this file can be short. Every element name, every element
value, every window title and every change summary already passes through one
function; a redaction policy is a decision about text, not an audit of the
codebase, only because that door was built before there was anything to keep
out of it.

Two rules decide, and neither of them reads the text.

The first is the element's own role. A password entry is a password entry
whether it currently holds a passphrase, a typo or nothing at all, and the
toolkit says so. The second is the application it belongs to: a password
manager's entire window is a list of secrets wearing ordinary roles, and a
policy that only knew about password fields would hand over every one of them
as a perfectly innocent label.

What is deliberately absent is any inspection of the text itself. A rule that
redacted anything shaped like a key would redact a chat message about a key,
miss a passphrase that reads like a sentence, and leave the caller unable to
predict either. Guessing from content produces a redaction nobody can reason
about; a role and an application name are facts.

A redacted value is replaced, never omitted. The element still appears, still
has an id, and can still be typed into — an agent filling in a login needs to
know the field is there. It reads back as a marker rather than as text, so the
difference between "empty" and "withheld" survives the trip, and a model that
sees one is not left to conclude the other.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import model

#: What stands in for text that was withheld. It is not empty, and it is not a
#: run of asterisks: an agent that read `••••••••` back could reasonably decide
#: that eight characters is the password, and try to use it.
MARKER = "[redacted]"

#: Roles the accessibility layer uses for text the user is not meant to be able
#: to read back off the screen. Every toolkit here agrees on the first one; the
#: rest appear on the same widgets under other bindings.
SECRET_ROLES = frozenset({"password text", "password_text", "passwordtext"})

#: A state, rather than a role, on toolkits that reuse the ordinary entry role
#: and mark the widget instead. GTK4 does exactly this.
SECRET_STATES = frozenset({"is-password", "password"})


def is_secret_element(role: str, states: tuple[str, ...] | list[str] = ()) -> bool:
    """Whether this element's text is a secret by the toolkit's own account.

    Asked of the role and the states rather than of the text, so that an empty
    password field and a full one are treated identically. A field the user has
    not typed into yet is not less sensitive; it is the same field.
    """
    if role.strip().casefold().replace("-", " ") in SECRET_ROLES:
        return True
    marked = {state.strip().casefold() for state in states}
    return bool(marked & SECRET_STATES)


@dataclass(frozen=True)
class RedactionPolicy:
    """The policy installed on the egress point for the life of the service.

    `sensitive_applications` names applications whose text never leaves at all,
    matched the way the capture blocklist matches: on the application's name,
    because element ids and window ids are per-session handles and a list that
    has to be rewritten every time the desktop restarts is a list nobody keeps
    accurate.
    """

    sensitive_applications: frozenset[str] = frozenset()
    marker: str = MARKER
    #: Titles are text the user typed somewhere, and a password manager's window
    #: title is the name of the account being looked at. Withheld along with
    #: everything else in a sensitive application, but never in an ordinary one,
    #: where the title is how a human recognises the window in a summary.
    redact_titles_in_sensitive_applications: bool = True

    def __call__(self, context: model.ValueContext) -> str:
        if is_secret_element(context.role, context.states):
            # The label is not the secret. "Password", "Confirm password",
            # "Master key" — these are how an agent tells which field is which,
            # and withholding them turns a login form into three anonymous
            # boxes it has to guess between. What is withheld is the contents.
            if context.field == model.NAME:
                return context.text
            return self.marker
        if self._application_is_sensitive(context.application):
            if context.field == model.APPLICATION_NAME:
                return context.text
            if context.field == model.TITLE and not self.redact_titles_in_sensitive_applications:
                return context.text
            return self.marker
        return context.text

    def _application_is_sensitive(self, application: str) -> bool:
        name = application.strip().casefold()
        if not name:
            return False
        return any(candidate in name for candidate in self.sensitive_applications)

    def with_applications(self, names: list[str] | tuple[str, ...]) -> RedactionPolicy:
        cleaned = frozenset(name.strip().casefold() for name in names if name.strip())
        return RedactionPolicy(
            sensitive_applications=cleaned,
            marker=self.marker,
            redact_titles_in_sensitive_applications=self.redact_titles_in_sensitive_applications,
        )


#: Applications whose contents are secrets by default, listed here rather than
#: left to configuration because a default that has to be discovered is a
#: default that leaks first and gets configured afterwards. Substring matched:
#: "Bitwarden - Chrome" is Bitwarden. Configuration adds to this; the plan is
#: explicit that a caller may narrow what it can see and never widen it.
DEFAULT_SENSITIVE_APPLICATIONS = frozenset(
    {
        "bitwarden",
        "1password",
        "keepassxc",
        "keepass",
        "lastpass",
        "dashlane",
        "enpass",
        "seahorse",
        "gnome-keyring",
        "keyring",
        "polkit",
        "gcr-prompter",
        "ssh-askpass",
        "pinentry",
        "authenticator",
    }
)


def default_policy(extra_applications: list[str] | tuple[str, ...] = ()) -> RedactionPolicy:
    """The policy the service installs at startup.

    Configuration extends the built-in list rather than replacing it: a config
    file that named its own applications and thereby switched off the defaults
    would be a footgun aimed at exactly the thing this module exists to protect.
    """
    names = set(DEFAULT_SENSITIVE_APPLICATIONS)
    names.update(name.strip().casefold() for name in extra_applications if name.strip())
    return RedactionPolicy(sensitive_applications=frozenset(names))


def install(extra_applications: list[str] | tuple[str, ...] = ()) -> model.ValuePolicy:
    """Put the policy on the egress point, returning the one it replaced."""
    return model.set_value_policy(default_policy(extra_applications))
