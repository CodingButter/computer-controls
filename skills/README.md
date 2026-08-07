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

## And then something reads it

The screens above are patterns, and the questions that decide whether a route
should leave the machine that learned it are not questions a pattern can be
asked. So the last step before a pull request exists is a reader — a model,
handed the rendered `SKILL.md` byte for byte, and asked three things:

1. Does anything in this name a person, a subject line, an employer, a path
   under somebody's home directory or a hostname?
2. Could following this destroy, send, pay for or delete something without
   saying so first? Being told by running it is being told too late.
3. Is this a route at all, or one installation's window titles and folder
   layout — that machine's configuration with extra steps?

Two rulings hold this up. A reader that could not be reached is **not** a pass:
an expired credential, a rate limit or an answer in words the gate cannot read
is an absence, it is recorded under its own name so an operator can tell it from
a bad route, and nothing is proposed. And there is no override — no flag, no
environment variable — because a gate with a way past it is a gate whose way
past it becomes the way.

What lands in the published `REVIEW.md` is which readers answered and what they
answered, never their reasoning: a published file quoting a model's prose is a
published file whose contents a model chose. Two readers agreeing is a stronger
signal than one insisting, and both are weaker than yours. A machine having read
it is a reason the pair is worth your time; it is not a reason to merge.

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
    SKILL.md      the route
    REVIEW.md     the case for it
    FETCHED.json  present only if this machine downloaded it
```

A folder whose `SKILL.md` claims a different name than the folder is refused at
load. An agent told it is using one skill while following another has been
handed a route it did not ask for, and that is the shape a poisoned submission
takes.

## The two verbs a person has

**Publish one skill.** You are shown the rendered `SKILL.md` and its `REVIEW.md`
in full — not a summary, because a summary is an argument and an argument for a
poisoned skill is exactly what this gate exists to stop — and then one button
sends those same bytes. It goes to the project's own service, not to GitHub from
your machine: publishing needs no account, no token and no `git` here, because
the credential lives on the service and the screens run again there where a
modified client cannot skip them. Afterwards you are told it was proposed, and
where.

**Fetch the ones other people published.** This folder is already the place the
runtime reads, so a fetched skill is just a merged pair landing in it, with no
more authority than one this machine worked out. It arrives with its review, so
you can read why the collective took it. It is checked on arrival the same way
it was checked before it was published — nothing is trusted for having been
downloaded.

Fetching is opt-in and it is revocable. A downloaded skill carries a
`FETCHED.json` beside its pair, naming where it came from and when, which is
what lets you list what came from the commons and take it back out again.
Removing refuses any folder without that marker, so taking the commons off a
machine cannot cost it the routes it derived itself.

## For end users

This folder is in the repository and not in the release. Installing the product
does not download it; a checkout is the only place it exists, so the skills cost
an end user nothing until curated ones are shipped deliberately.
