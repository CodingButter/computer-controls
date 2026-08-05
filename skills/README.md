# The skill commons

A skill in here is a **route**: the sequence of protocol calls, element roles and
landmarks that got an agent from a cold start to a finished task inside one
application. One agent worked it out. Every other agent, on every other machine,
would otherwise work it out again.

Two failures made this folder. An agent spent fifty nodes of an accessibility
tree finding a Discord private message and had nowhere to put what it learned.
A different agent, having failed the same task earlier, kept the belief — *I
cannot read Discord* — and answered from it rather than trying again. Those look
like opposite problems and they are the same missing organ.

## What a skill is not

**It is not a fact.** "Discord is at process 4821" is true for an hour. A route
is true until the application is redesigned, which is why the frontmatter names
the version it was last verified against.

**It is not authoritative.** A skill is what worked somewhere else. An agent
following one verifies each step against the tree in front of it. A landmark
that is not there is a skill to amend, not a step to retry — a skill that can
only rot is worse than no skill, because it is the stale-belief problem with
better formatting.

**It is not code.** Nothing here executes. The commons carries procedures, never
scripts and never binaries, and any submission that arrived carrying one would
be refused on that ground alone.

## Why this is not just a shared folder

Text that shapes an agent's behaviour, downloaded automatically from strangers,
is a supply chain. A poisoned skill is a prompt injection with a delivery
service. So the same ruling the plugin registry makes applies here: an agent
**publishes a candidate**, and the registry **admits** it. Never a direct push.

What admits it is a person reading two files.

## The pair

Every submission is two files, and both are meant to be read before either is
merged.

| file | written for | what it carries |
| --- | --- | --- |
| `SKILL.md` | the agent that will follow the route | the steps, the landmarks, the version last verified, the amendment history |
| `REVIEW.md` | the person deciding whether it should exist | what the route has an agent *do*, and the evidence for each step |

Both are generated from enumerated fields by a template. Neither is written by
an agent in prose, and there is no field an agent can put a sentence in —
because a registry that can be handed a sentence is a registry that can be
handed a password, and scanning the sentence afterwards does not fix that.

## What is screened before a pull request opens

On the machine that derived the route, while a refusal is still free:

- **Shape.** Every method, role and landmark is held to a pattern or a closed
  vocabulary. A role is one of the words the accessibility layer uses. A
  landmark is at most three words of letters. That refuses a sentence, a
  message, an address, a key and a password.
- **The bar.** A route that worked once is a candidate. Twice, in distinct
  attempts, is a skill. Once is an incident.
- **The application.** A route through a password manager is refused whatever it
  says, because the interesting elements in one are exactly the elements the
  desktop service withholds.
- **The rendered text.** Both files are scanned once more for addresses,
  telephone numbers, payment cards, links and key-shaped strings.

Refusals are recorded. The record names the screen and never what it found —
an audit trail that quoted the address it was refusing would be publishing it
helpfully.

## What the screens cannot answer, and you can

`Private Channels` and `Alice Nichols` are the same shape: two capitalised words,
no digits, no punctuation. No pattern distinguishes them, and one that claimed to
would be a pattern somebody trusted.

So when you review a pair, the question is:

1. Is each landmark in `REVIEW.md` a fixed piece of that application's chrome, or
   a word that happened to be on the screen that day?
2. Does the route go somewhere an agent following it should be going?

A step whose justification is missing from the review is not a step somebody
forgot to explain. It is a finding.

## Provenance

Git is the provenance store. Who proposed a skill, when, what changed in an
amendment and who admitted it are the repository's history rather than a second
record that can disagree with it. There is no database and no manifest: the
folder is the index.

Submissions carry a pseudonymous installation id rather than a person, which is
enough to cut off a machine that starts proposing poison and not enough to know
whose machine it was.

## Layout

```
skills/
  <app>-<task>/
    SKILL.md     the route
    REVIEW.md    the case for it
```

A folder whose `SKILL.md` claims a different name than the folder is refused at
load. An agent told it is using one skill while following another has been
handed a route it did not ask for, and that is the shape a poisoned submission
takes.

## For end users

This folder is in the repository and not in the release. Installing the product
does not download it; a checkout is the only place it exists, so the skills cost
an end user nothing until curated ones are shipped deliberately.
