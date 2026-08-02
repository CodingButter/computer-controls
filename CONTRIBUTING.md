# Working on this repository

Most of the work here is done by agents — some in sandboxes with no desktop, one on the machine
the desktop actually lives on, and occasionally a person. This file is how those three stay out of
each other's way. It is written for whoever picks up an issue, whether or not they can see a
screen.

## The seam: what you can prove where

Every claim this project makes has to be provable by whoever makes it. That splits the work along
one mechanical line — which test lane can judge it.

```sh
cd service
.venv/bin/python -m pytest -q --no-live     # portable. No display needed. Runs anywhere.
.venv/bin/python -m pytest -q --live-only   # needs a real desktop session.
```

A test is in the live lane because of **what it asserts**, never because of what it is called. If
it asks a question only a running desktop can answer — is this window focused, did the toolkit
accept this text, does this application expose actions — it is a live test and it carries the
marker. `service/conftest.py` applies the marker to `*_live.py` modules automatically; anything
else that needs a desktop marks itself, and says why in the reason.

So:

- **If your work is provable with `--no-live`, you can finish it wherever you are.** Protocol
  shapes, the delta engine, the claim registry, redaction, consent, attention, cadence arithmetic,
  audit records — all of it is portable and all of it is judged by tests you can run.
- **If it is only provable with `--live-only`, you cannot finish it alone.** Open the PR with the
  portable half green and say plainly, in the PR body, what you could not run. Somebody with a
  desktop runs the other half. Writing a live test you cannot execute is a *contribution*, not a
  failure — that is how the deletion proof landed.
- **If it needs a human at the keyboard**, it is a third lane, off by default, opted into with an
  explicit environment variable ([#33](https://github.com/CodingButter/computer-controls/issues/33)
  — the marker is designed, not yet built; until it is, such a proof lives in `scripts/` where
  pytest does not collect it). It must never gate a PR. A test that can only pass when a specific
  person is at a specific machine is a test that fails for everybody else forever.

## One writer for the protocol

`protocol/schema.json` is the contract, and both validators are generated from it —
`plugin/src/protocol.generated.ts`, `plugin/src/schemas.generated.ts`,
`service/desktop_service/protocol_generated.py`. Never edit a generated file. Run
`node scripts/generate-protocol.mjs` and commit what it produces.

**Do not change the schema in a feature branch unless the issue says the change is yours.** Four
branches editing the contract at once produce four different schema digests, and every one of them
leaves the shared daemon stale for everybody. If your issue needs new protocol surface, say so on
the issue and the schema change arrives first, on its own, before the behaviour is built on top of
it.

Changing the schema changes `SCHEMA_DIGEST`. That is not cosmetic — see below.

## Always run the current daemon

The service is a long-lived shared daemon. It serves the code it booted with, forever, no matter
what the working tree says. A stale daemon reports `METHOD_NOT_FOUND` for a method you can read in
the source, which is a genuinely maddening hour if you do not know to check.

After anything that regenerates the protocol, restart it, and check:

```sh
# the digest the daemon serves must equal the digest in the tree
grep -m1 SCHEMA_DIGEST service/desktop_service/protocol_generated.py
```

The `hello` result carries `schemaDigest` for exactly this comparison. If they differ, nothing you
observe is evidence of anything.

## What a finished piece of work looks like

Before a PR is ready:

```sh
cd service && .venv/bin/python -m pytest -q --no-live   # or the full suite if you have a display
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
