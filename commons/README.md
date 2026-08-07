# The service that holds the credential and opens the pull request

Publishing a skill used to require a GitHub account, a token, a checkout and a
working `gh` on the machine that derived the route. That is a requirement about
the contributor rather than about the skill, and the collective this commons is
for is not a collective of git users. Somebody who worked out how to read a
private message in Discord has something worth publishing whether or not they
have ever opened a terminal.

So the credential moves here. One account posts every proposal, it lives on a
server, and a contributor sends a submission and receives a pull request number.

## One verb

```
POST /submissions
```

```json
{
  "skill":       { "app": "…", "task": "…", "steps": [ … ], … },
  "document":    "…the SKILL.md you were shown…",
  "review":      "…the REVIEW.md you were shown…",
  "attribution": "jamie"
}
```

`skill` is `skill_commons.as_document(skill)` — enumerated fields, no prose.
`document` and `review` are the pair the contributor was looking at when they
pressed the button; they are **compared, never published**. This service renders
its own pair from `skill` and posts what it rendered, so nothing anybody typed
reaches the repository, and a client that showed one thing and sent another is
refused rather than believed.

`attribution` is optional and is the only place a person can be named. Left out,
nothing in the pull request identifies anybody: the proposal carries a
pseudonymous installation id and that is all.

There is no field a credential could arrive in, and a payload carrying an
unexpected key is refused *by the name of the key* — so that somebody who has
just sent a token to a machine that does not want it is told, and can go and
revoke it.

## What comes back

| status | meaning |
| --- | --- |
| `201` | proposed; the body carries the pull request number |
| `422` | screened and refused; the body carries every screen that said no |
| `413` | larger than the limit, with the limit in the reason |
| `429` | a limit: this installation's open proposals, or this service's hourly ceiling |
| `503` | this service could not post — no credential, or the forge would not answer |

`503` before anything else when several apply. A submission refused for something
the contributor could fix *and* something only this service can must not be
reported as theirs to fix, or they go and edit a route that was never the problem.

A refusal is always a document, never a dropped connection:

```json
{
  "published": false,
  "refusals": [{ "screen": "recurrence", "because": "the route has worked 1 time(s) …" }]
}
```

Screen names come from a closed vocabulary, so a client can branch on them; the
sentences are for the person. Neither ever quotes what was refused.

## The gate runs here too

`skill_commons.validate` still runs on the contributor's machine, before anybody
is shown anything, because a refusal that arrives before a submission is a better
refusal. It is not evidence. Every screen — recurrence, application, navigable,
content-free — runs again on arrival against the text this service is about to
publish, and there is no field a client can set to say it already screened
something.

## The limits, and the one that actually holds

Three, and all three are refusals with reasons: a size limit on the body, a cap of
three open proposals per installation, and a ceiling of thirty proposals an hour
for the service as a whole.

The cap is the courteous one and the ceiling is the real one. An installation id
arrives in the payload, and nothing authenticates it — nothing *can*, because the
point of this service is that a contributor has no account here. A client that
invents a new id per submission has a fresh cap every time. The ceiling is
counted here, spent by everybody together, and is what bounds the worst a loop can
do to a page of pull requests rather than a repository nobody can read. If this
service is ever put somewhere that needs a stronger answer than that, the answer
is in front of it, not in here.

Proposals are also serialised. The forge switches a branch, writes two files,
commits and pushes in a working copy this process shares with every request it is
serving; two of those interleaved is a branch carrying somebody else's skill,
which is the failure the whole pair-and-review design exists to prevent. The
server is threaded so a refusal never waits behind a push, and the push is one at
a time.

## Running it

```sh
COMMONS_GITHUB_TOKEN=… python -m commons_service \
    --repo owner/name --checkout /srv/commons --base main --port 8781
```

The credential is read from the environment, where `gh` already looks for it, so
it is never an argument in a process list or a line in a shell history. It is
checked at boot *and* at every publish: a token that was there when this started
is not a token the forge will still accept an hour from now.

## What this cannot do

It cannot reach a desktop. It imports nothing from `desktop_service`, starts no
subprocess of its own, opens no socket of its own, and has no verb that names a
session or an element — `commons_service_tests/test_nothing_here_reaches_a_desktop.py`
fails if that ever stops being true.

It cannot merge. `skill_commons.forge` deliberately has no merge, approve or
label method, and putting the credential on a server does not add one. Publishing
and admitting stay separate verbs, and the second one is a human's.

## Still needed

Where this runs and which account posts are decisions for whoever owns the
repository. Everything above is buildable, testable and tested against a fake
forge; neither of those two answers changes a line of it.
