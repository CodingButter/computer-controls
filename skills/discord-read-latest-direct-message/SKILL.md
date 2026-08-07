---
name: "discord-read-latest-direct-message"
description: "Read latest direct message in discord. A route derived by an agent, amended after a verified failure against discord 1.0.151 (the app self-updates its UI independently of the deb version)."
metadata:
  app: "discord"
  task: "read-latest-direct-message"
  app-version-verified: "1.0.151"
  last-verified: "2026-08-07"
  verified-count: 4
  derived-by: "client-7"
  amended-by: "wren-main-loop"
  signature: "7ad623df893c5e28"
---

# discord: read latest direct message

This route is advisory. It is what worked on another machine, against the version named above. Verify each step against the tree in front of you — a landmark that is not there is a skill to amend, not a step to retry.

## The route

| step | call | element | landmark |
| --- | --- | --- | --- |
| 1 | `census` | — | — |
| 2 | `setAttention` | `window` | — |
| 3 | `queryElements` | `list` | `Direct Messages` |
| 4 | `queryElements` | `link` | `(direct message)` |
| 5 | `invokeElement` | the matched `link` | action `jump` |
| 6 | `queryElements` | `list` | `Messages in` |
| 7 | read the last `article` descendants | — | — |

## Landmarks

- `Direct Messages` — the sidebar list. The old landmark `Private channels` is dead; Discord renamed it.
- `(direct message)` — every DM entry is a `link` named `<display name> (direct message)[, <presence>]`. The display name may use Unicode styled codepoints (mathematical bold etc.), so **match on the ASCII suffix `(direct message)` or NFKC-normalize the name before comparing** — a plain ASCII substring of the person's name can miss entirely.
- `Messages in <name>` — the message pane list, named after the open conversation.

## The three traps (each cost a failed run)

1. **The DM link name is nested.** DM list items are anonymous `section`/`list item` shells; the human-readable name lives ~3 levels down on a `link` element with actions `jump`/`showContextMenu`. Query for `role: link` with name filter — do not read list-item names, they are empty.
2. **The message pane is empty until the DM is opened.** The conversation `list` exposes zero children while closed. You MUST `invokeElement` (`jump`) on the DM link first; success is visible as the window title flipping to `@<name> - Discord`. A closed pane reading empty is not a permissions failure and not a missing accessibility flag.
3. **Unicode display names.** A user named in mathematical-bold codepoints will not match an ASCII search for their name. Normalize (NFKC) or anchor on the `(direct message)` suffix, then disambiguate by position/avatar name. Note that a server with a similar name (e.g. a guild) is not the DM — DMs live only under the `Direct Messages` list.

## Reading the messages

Each message in `Messages in <name>` is an `article` whose accessible name is `"<author> , <text> , <timestamp>"`. The last `article` in document order is the latest message. Date `separator` elements mark day boundaries.

## How stale this may be

Last verified against discord 1.0.151 (deb version; Discord hot-updates its web UI independently, which is how the tree changed under a frozen package version) on 2026-08-07, after this amended route succeeded end-to-end. If the application in front of you is newer than that, the route may still be right and is no longer evidence.

## Amendments

- 2026-08-07: The original route failed three ways against the SAME deb version it was verified on (1.0.151) — Discord hot-updates its UI remotely, so `app-version-verified` is a weak staleness signal for this app. The failures: the `Private channels` landmark no longer exists (now `Direct Messages`), the DM name moved onto a nested `link`, and the message pane is unreadable until the DM is invoked. Route rewritten with the open-the-DM step and Unicode-safe matching. Derived from a live failure where the agent matched a similarly-named server instead of the DM and then misreported a missing accessibility flag (the flag was present — see issue #194).

## What is not here, and why

No element ids, no window titles beyond their shape, no field contents, nothing read out of the application. An element id names one session and would make this a route that worked exactly once while looking like a route that worked. Everything else on that list is somebody's, and this file is on a public server forever.
