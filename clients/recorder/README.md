# The episode store

Desktop work, recorded as a git repository, so that an agent can learn a task
from how it was done and another agent can review it the way people review a
pull request.

The mapping is the whole design:

| git | episode |
| --- | --- |
| branch | one episode, named for its intent — `sell-the-ps5` |
| commit | one deliberate action |
| commit message | the intent of that action, in a sentence |
| diff | what changed on the desktop, as the delta engine reported it |
| author | the client identity the service issued at the handshake |
| merge to `main` | the episode worked; this is how the task is done |
| unmerged branch | a sideways attempt — still readable, not yet a lesson |
| tag | the outcome — `sold-for-520` |
| note | a reviewer's remark, attached to the step it is about |

## What it is not

It is not a recorder in the screen-capture sense, and it is not a macro. There
are no coordinates anywhere in an episode, by construction rather than by
filtering: an episode is written in element ids, roles, names and actions.
Coordinates do not travel; semantics do. A replay of pixel positions would work
on one machine, on one day, at one resolution, and would teach a reader nothing
about what the work actually was.

It is also not part of the service. `service/` gained no method for recording,
and this package imports nothing from it. Recording is something a client does
with the answers it already received.

## How it records

The recorder never looks at the desktop. It is handed what a driving client
already has:

- the `clientId` from `hello`, which is the author of every commit it writes
- each `actionResult`, which carries `observedEffects` — the delta engine's own
  account of what moved, already stamped with a revision range

That constraint is the design, not an economy. A second observation path could
disagree with the first, and then an episode would be a record of something
that never happened. The delta engine computes these diffs already and throws
them away once they have been announced; the store is what catches them.

```python
from episode_recorder import Agent, Recorder

recorder = Recorder("~/.local/share/computer-controls/episodes")

agent = Agent(
    client_id=hello["clientId"],      # the fact: issued by the service
    label="lister",                   # the claim: what the client calls itself
    instructions=...,                 # what it was told
    prompt=...,                       # what it was asked
    tools=(...,),                     # what it was holding
    model="claude-opus-5",            # what it was run on
)

episode = recorder.open("sell the PS5", agent)
episode.step("open the listing form", "invokeElement", "el-sell", result)
episode.step("put in the price", "typeText", "el-price", result)
episode.close("sold for 520", worked=True)
```

The branch is `sell-the-ps5`, and `git log` on it reads as an account of the
work. Because `worked=True`, it merged to `main` and carries the tag
`sold-for-520`. Had it not worked, the branch would simply be left there —
readable, reviewable, and not mistaken for how the task is done.

An episode opens by declaration. Agents get that free, because an agent is told
what it is about to do. For a human the boundary is one sentence — *pay
attention, I'm about to post something* — which becomes the branch name and the
first commit.

## What is at the head of a branch

```
intent.md                      the declaration
agent/instructions.md          what the agent was told
agent/prompt.md                what it was asked
agent/tools.json               what it was holding
agent/model.txt                what it was run on
steps/0001.json                one file per action, one commit each
desktop/focus                  where focus is now
desktop/elements/<id>.json     what the service said about each element
desktop/windows/<id>.json      what the service said about each window
```

The agent's own files sit at the head of every episode because a review that
cannot see the instructions is a review that will blame a good agent for a bad
brief.

## Reviewing

A reviewing agent reads a branch it did not perform, remarks on specific steps
with the diff of those steps in front of it, and ends with a proposal:

```python
from episode_recorder import Review

review = Review(recorder.store.path, reviewer_author)
steps = review.steps("sell-the-ps5")

review.remark(steps[1], "typed 50 into a price field that wanted 500")
review.propose("sell-the-ps5", better_instructions,
               "check a price field reads back what you meant before posting")
```

A remark is a git note, so it never rewrites the episode — a reviewer that
could edit the record would be editing the past. The conclusion is a branch
whose diff edits `agent/instructions.md`, which means a lesson arrives in the
shape of the fix rather than as a score somebody has to act on. It is a
proposal until somebody merges it. Agents then improve the way the repository
does: propose, review, merge.

## Agents are public. Episodes are not.

Git never forgets, so nothing sensitive may ever reach an object. The recorder
does not implement a redaction policy — a second policy is a second thing to
get wrong. It writes only what has already passed the service's value-egress
point, and the delta engine is stricter than it needs to be here anyway: it
reports that a value *grew by ten characters at the end*, never what it grew
to. A password field is recorded as a field that changed.

The arguments an action was called with are the hole that policy cannot close
on its own, since the client held that string before it ever made the call.
There is no field on a step for them, so there is nowhere for them to land.

`recorder_tests/test_nothing_sensitive_is_committed.py` seeds a password,
records real work over it, then reads back every object in the store —
including packed, unreachable and unmerged ones — and goes looking. "We would
have noticed" is not a safety property.

## Tests

```
pytest --no-live clients/recorder
```

No desktop required. The delta tests drive the service's real diff engine over
hand-built snapshots, because a recorder proved against a fake delta would only
prove the fake.
