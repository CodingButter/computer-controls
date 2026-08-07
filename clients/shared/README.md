# The shared desktop client

The half of a client that is not about the client.

Reaching the daemon means the same four things no matter who is asking: find
the socket, frame the JSON-RPC over it, correlate replies to requests, and turn
a failure into a sentence a person can act on. Every client needs all four and
none of them are a matter of taste, so they live here once.

This is not a hypothetical. Before this package existed the hub needed to ask
the daemon a single observe-class question to render its permissions page, and
the only implementation of the transport was inside the Mastra plugin — so the
hub wrote a second one: its own buffer scan, its own timer, its own error
strings. Two implementations of a wire format is one more than the protocol has
versions.

## What is here

| Module | What it holds |
| --- | --- |
| `src/desktop-client.ts` | `DesktopClient` and `DesktopServiceError`. Newline framing, the id correlation table, and a per-request timeout override so a deliberately slow call — typing a sentence at human speed — is not cut off at the default deadline. |
| `src/endpoint.ts` | Where the daemon listens, per OS. The schema digest is in the address, so two builds that disagree about the protocol never meet. |
| `src/discover.ts` | `findDaemonSocket`: which socket is the daemon, when one is already listening and nobody told us where. |
| `src/protocol.generated.ts` | Generated from `protocol/schema.json`. Never edited by hand. |

## What is deliberately not here

**Anything from `@mastra/*`.** This package imports node builtins and nothing
else, so a client that has never heard of Mastra Code — the Electron widget, a
future web client — can depend on it without inheriting an agent framework. The
Zod schemas stay in the plugin for exactly that reason: they import `z` from
`@mastra/code-sdk/plugin`, and a neutral library cannot.

**Starting a service.** `DesktopClient` connects to a daemon; it never spawns
one. Supervision — the venv, the child process, the attach-first decision — is
the Mastra plugin's `supervisor.ts`, because deciding to start a service is a
policy about a machine and not a fact about a socket.

**Census shapes, tool shapes, page shapes.** What a client does with an answer
is the client's business. `readCensus` stays in the hub.

## Consumers

`clients/mastra-plugin` and `client` (the hub) both import from here by
relative path, which is how this repository already shares TypeScript across
package roots. There is no build step and nothing is published.

## A Python mirror

There is not one, because there is no Python client of the daemon outside
comcon's own tests, and a second implementation with no second caller is how
implementations drift. The moment a Python client exists — a recorder that
watches rather than reads its store, a CLI that is not Node — this package
gains a sibling next to it, and the compatibility test that proves the two
speak the same protocol comes with it.
