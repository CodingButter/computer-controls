# The factory keeper, and why it refuses things

A Factory run can die without saying so. A server restarts mid-turn, a lease
expires, a session stops answering — and the work item is left on a
non-terminal stage with nobody coming to move it. Nothing in the Factory
notices. The keeper is the fifteen-minute cron that does: it looks for runs that
should be in flight and are not, and wakes them.

That is a real job and it stays. What changed is that the keeper now checks
whether waking a run makes any sense.

## What went wrong

The original keeper was twenty lines of SQL in a shell script on one machine,
outside version control. It asked two questions — is the fleet busy, and is
there a `sent` row — and requeued whatever it found.

Both questions are true of a run that finished perfectly. A completed run leaves
its row at `sent` forever, because nothing moves it, so the keeper woke it
again. And again. [Issue #210](https://github.com/CodingButter/computer-controls/issues/210)
is what that looked like from inside a session: nine identical triage kickoffs
over two and a half hours for work whose issue was closed and whose pull
requests were merged.

Three faults stacked up to produce it:

1. **The keeper never read the work item.** Not its stage, not its issue, not
   whether the kickoff's target stage had already been passed.
2. **The dispatcher's coalescing cannot collapse a replay.** Each delivery mints
   a fresh `kickoff_key`, so the `UNIQUE (org_id, factory_project_id,
   kickoff_key)` constraint that exists to coalesce these never matches twice.
   Nine firings, nine rows, `coalescedCount: 1` on every one.
3. **The payload freezes when the run start is prepared.** If the item's stage
   moves afterwards, the row keeps dispatching the old skill. Twenty-three
   `plan`-role bindings were still carrying `factory-triage` text — and
   `factory-triage` is explicitly forbidden from requesting a transition once an
   item is past Planning, so those runs *structurally could not end*. Which
   meant the row stayed `sent`. Which meant the keeper woke it again.

Only the first is ours. Faults 2 and 3 live in `@mastra/factory` and are
reported upstream; the gates here refuse their symptoms so the loop stops
either way.

## The gates

All of them live in `scripts/factory_keeper/gates.py` as one pure function.
No database, no clock, no network — every input is passed in, which is what
makes the whole decision testable.

| Gate | Refuses when | Permanent |
|---|---|---|
| `G0-binding-revoked` | the binding is no longer active | yes |
| `G0-row-expired` | the row is older than 24 hours | yes |
| `G1-item-missing` | the binding points at no work item | yes |
| `G1-terminal-stage` | the item is `done` or `canceled` | yes |
| `G2-issue-closed` | the linked GitHub issue is closed | yes |
| `G3-payload-role-mismatch` | the payload's skill is wrong for the binding's role | yes |
| `G4-role-stage-mismatch` | the binding's role cannot act at the item's stage | yes |
| `G5-no-payload` | the row has no message to dispatch | no |
| `G6-thread-active` | the bound thread spoke in the last 20 minutes | no |

**Permanent** means no later tick can change the answer. `reconcile` retires
exactly those and nothing else. `G6` is the opposite: the run is alive and
working, and waking it would interrupt it — twenty minutes rather than fifteen
so that a run answering on every tick is never woken twice for one silence.

Two gates deliberately **fail open**, and this is the most important thing to
know before adding a third. `G3` and `G4` judge only roles whose correct
behaviour is known. A `work`-role binding legitimately carries a `factory-plan`
payload — thirteen of them did while this was being written, including the run
that implemented these gates — so a table mapping one skill per role would have
refused its own kickoff. Likewise a GitHub lookup that fails returns "unknown",
never "closed": a keeper that halted the fleet because `gh` was missing from
cron's `PATH` would be a worse bug than the one being fixed.

## The failure mode to fear

Under-gating replays kickoffs, which is noisy and obvious. Over-gating silently
halts all issue work, which looks exactly like a quiet afternoon. This
repository already carries a commit called *stop the two faults that silently
halted all issue work*; that is the direction things break.

So every refusal is logged with its gate and its reason, and the mutation suite
(`service/tests/test_factory_keeper_mutation.py`) breaks each gate in both
directions and requires the tests to go red. Disabling a gate must fail. Making
a gate refuse too much must also fail.

If the fleet ever goes quiet, this is the first command to run:

```bash
./scripts/factory-keeper.sh --dry-run
```

It writes nothing, reports through the capacity guard, and prints one line per
row naming the gate that refused it.

## Running it

```bash
./scripts/factory-keeper.sh                    # what cron runs
./scripts/factory-keeper.sh --dry-run          # decide, write nothing
python3 -m factory_keeper.reconcile            # list rows to retire
python3 -m factory_keeper.reconcile --apply    # retire them
```

`reconcile` marks permanently-refused rows `failed` with a `last_error` naming
the gate. `failed` rather than deleted on purpose: these rows are the evidence
for #210 and for whatever upstream concludes, and a tidied table cannot answer
questions. Purging is a separate decision, to be made after the forensics are
read.

Both tools take `--org-id` to confine a run to one tenant. Without it they act
on the whole table, which is what cron wants and what tests must never do.

## Tests

```bash
# portable: gates, mutations, and the database integration if a container answers
service/.venv/bin/python -m pytest -q --no-live service/tests/test_factory_keeper*.py
```

The database tests are not marked `live`. That marker means *drives a real
desktop*, and its gate probes X11 — which would give a false explanation on a
headless machine with a perfectly healthy Postgres. They self-skip on the
condition they actually care about: whether the container answers.

## Where this goes next

The gates are a symptom fix. `G3` exists only because the dispatcher freezes
payloads, and `G4` only because it dispatches stage-inappropriate skills. The
real repair is upstream: scope the kickoff key to the *condition* rather than
the delivery, the way the rules engine already keys its own idempotency
(`${ingress.id}:${skill}`), and consult stage and issue state before re-kicking.

When that lands, most of this can be deleted — and the gate log is how we will
know, because the `G3` and `G4` lines will stop appearing.
