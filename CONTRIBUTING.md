# Working on this repository

Most of the work here is done by agents — some in sandboxes with no desktop, one on the machine
the desktop actually lives on, and occasionally a person. This file is how those three stay out of
each other's way. It is written for whoever picks up an issue, whether or not they can see a
screen.

## The seam: what you can prove where

Every claim this project makes has to be provable by whoever makes it. That splits the work along
one mechanical line — which test lane can judge it.

```sh
cd comcon
.venv/bin/python -m pytest -q --no-live     # portable. No display needed. Runs anywhere.
.venv/bin/python -m pytest -q --live-only   # needs a real desktop session.
```

A test is in the live lane because of **what it asserts**, never because of what it is called. If
it asks a question only a running desktop can answer — is this window focused, did the toolkit
accept this text, does this application expose actions — it is a live test and it carries the
marker. The repository-root `conftest.py` applies the marker to `*_live.py` modules
automatically; anything else that needs a desktop marks itself, and says why in the reason.

So:

- **If your work is provable with `--no-live`, you can finish it wherever you are.** Protocol
  shapes, the delta engine, the claim registry, redaction, consent, attention, cadence arithmetic,
  audit records — all of it is portable and all of it is judged by tests you can run.
- **If it is only provable with `--live-only`, you cannot finish it alone.** Open the PR with the
  portable half green and say plainly, in the PR body, what you could not run. Somebody with a
  desktop runs the other half. Writing a live test you cannot execute is a *contribution*, not a
  failure — that is how the deletion proof landed.
- **If it needs a human at the keyboard**, it is a third lane: mark it `@pytest.mark.human` and it
  is deselected everywhere by default, including on the desktop machine, stating that it needs a
  person. `DESKTOP_HUMAN_PRESENT=1 .venv/bin/python -m pytest -q` is the only thing that selects
  it — set inline on the invocation, never exported from a shell rc, where it would be on silently
  forever. It must never gate a PR. A test that can only pass when a specific person is at a
  specific machine is a test that fails for everybody else forever.

## One writer for the protocol

`protocol/schema.json` is the contract, and both validators are generated from it —
`plugin/src/protocol.generated.ts`, `plugin/src/schemas.generated.ts`,
`comcon/desktop_service/protocol_generated.py`. Never edit a generated file. Run
`node scripts/generate-protocol.mjs` and commit what it produces.

**Do not change the schema in a feature branch unless the issue says the change is yours.** Four
branches editing the contract at once produce four different schema digests, and every one of them
leaves the shared daemon stale for everybody. If your issue needs new protocol surface, say so on
the issue and the schema change arrives first, on its own, before the behaviour is built on top of
it.

Changing the schema changes `SCHEMA_DIGEST`. That is not cosmetic — see below.

## Always run the current daemon

The service is a shared daemon, and it serves the code it booted with no matter what the working
tree says. A stale daemon reporting `METHOD_NOT_FOUND` for a method you can read in the source cost
a genuinely maddening hour, three separate times, before the socket name started carrying the
digest.

It does now: `daemon-<SCHEMA_DIGEST>.sock`. Regenerate the protocol and your client looks for a
socket that does not exist yet, so it starts a daemon that matches instead of talking to the one
that does not. There is nothing to remember and no error to read, because two builds that cannot
understand each other never meet.

What still bites: a **schema-identical** change — editing a handler without touching
`protocol/schema.json` — keeps the same digest, so the old daemon is still the right daemon by the
only test the filesystem can run. That one you restart by hand:

```sh
pkill -f "desktop_service --daemon"   # or just let it idle out
```

The `hello` result still carries `schemaDigest`, and `staleDaemonHint` still diagnoses a mismatch,
for the cases the socket name cannot catch. If they differ, nothing you observe is evidence of
anything.

## What a finished piece of work looks like

Before a PR is ready:

```sh
cd comcon && .venv/bin/python -m pytest -q --no-live   # or the full suite if you have a display
cd ../plugin && npx tsc --noEmit && npx vitest run
node scripts/generate-protocol.mjs                       # and check it produced no diff
```

And then the part that is not a command: **prove the change does what you say it does.** A green
suite proves the tests pass. It does not prove the tests would fail if the code were wrong.

For anything load-bearing — a permission check, a refusal, a guarantee — break it on purpose and
watch the suite go red. If it stays green, the test is decoration and the finding is yours to
report. Several rules in this repository were caught that way, including one where the test itself
was performing the work it was meant to be observing, and so was testing the fallback and
reporting it as the rule.

If your mutation harness patches source text, have it assert the patch applied. A mutation that
silently fails to apply passes on nothing and tells you the code is safe.

## Issues

An issue is the entire world of whoever picks it up. It must carry:

- **The ruling** — the decision this work implements, quoted, in the words it was made in. Not a
  paraphrase. The reasoning is usually load-bearing and paraphrase is where it goes missing.
- **The acceptance test, by filename.** What has to exist and pass for this to be done.
- **A routing label** — `sandbox-safe` when `--no-live` can judge it, `needs:desktop` when it
  cannot.

No issue without a ruling. If nobody has ruled on it yet, it is a question, and it goes to whoever
can answer it before it becomes work.

**And when the work depends on work that has not landed yet, the issue says so, in a
`Depends on:` line naming the PR or issue and what it provides.** An issue is read by somebody
starting from `main`, and `main` is the only thing they can see. Work that assumes a package,
a route, or a seam that exists only on a branch will be built twice: once against nothing, and
again after the rebase. That is not a merge conflict, it is a day. The dependency line is what
stops the second build from happening.

Nothing starts until what it depends on is merged. If the dependency slips, the issue waits —
building ahead of it produces a branch that has to be reconciled by hand with whatever actually
landed, which is the expensive kind of rework.

## Merging in the right order

Several branches at once is normal here. Losing one to a bad merge is not, and the way that
happens is always the same: two branches both taught the same shared file about a new thing.

- **Own your files.** A new page owns its own directory and its own data slice. Where a shared
  file cannot be avoided, the shared edit should be *one line* — an export, a route mount, a nav
  entry — because a one-line collision is resolvable and a rewritten file is not.
- **Rebase before you open, rebase again before you merge.** The base moves; a PR that was
  mergeable an hour ago is a claim, not a fact.
- **Merge one at a time, and re-check the rest.** After each merge, every other open PR against
  the same area is re-checked for mergeability. GitHub reporting a conflict is the cheap
  discovery; a green merge that silently drops somebody's change is the expensive one.
- **When the base moves under open work, say so on the issue and the PR.** The branch cannot
  smell it.

## Reviews

PRs are reviewed adversarially before merge, by models with no stake in the change. Their findings
are triaged, not obeyed: two reviewers agreeing is a strong signal, one reviewer asserting
something the code contradicts is a finding about the reviewer.

When a review is answered, answer it in the PR — which fix closes which finding, which findings
were declined and why, and what the tests would do if the fix were reverted. A fix nobody can
locate is indistinguishable from a fix nobody made.

## Things that are never done here

- **Never `kill -9` an application on a live desktop.** There is a person's unsaved work in those
  windows. Close things through their own semantic actions, the same way this service asks
  everybody else to.
- **Never write into a document that has content in it** during a test or a proof, unless the
  content is yours. Skipping costs a test run. Guessing costs somebody their afternoon.
- **Never claim a result you did not observe.** "The tests pass" means you ran them. If you could
  not run them, say which ones and why — that sentence is worth more than a confident one.
