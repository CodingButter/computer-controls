---
name: "discord-read-latest-direct-message"
description: "Read latest direct message in discord. A route derived by an agent, verified 3 times against discord 1.0.151."
metadata:
  app: "discord"
  task: "read-latest-direct-message"
  app-version-verified: "1.0.151"
  last-verified: "2026-08-05"
  verified-count: 3
  derived-by: "client-7"
  signature: "7ad623df893c5e28"
---

# discord: read latest direct message

This route is advisory. It is what worked on another machine, against the version named above. Verify each step against the tree in front of you — a landmark that is not there is a skill to amend, not a step to retry.

## The route

| step | call | element | landmark |
| --- | --- | --- | --- |
| 1 | `census` | — | — |
| 2 | `setAttention` | `window` | — |
| 3 | `describeElement` | `document text` | — |
| 4 | `describeElement` | `list` | `Private channels` |
| 5 | `describeElement` | `list item` | — |

## Landmarks

- `Private channels`

## How stale this may be

Last verified against discord 1.0.151 on 2026-08-05, after 3 successful runs. If the application in front of you is newer than that, the route may still be right and is no longer evidence.

## Amendments

None. This is the route as it was first derived.

## What is not here, and why

No element ids, no window titles, no field contents, nothing read out of the application. An element id names one session and would make this a route that worked exactly once while looking like a route that worked. Everything else on that list is somebody's, and this file is on a public server forever.
