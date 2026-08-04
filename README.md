# computer-controls

A Mastra Code plugin that gives a coding agent a **semantic** interface to a Linux desktop —
applications, windows, dialogs, buttons, text fields — instead of screenshots, OCR and
coordinate guessing.

- `plugin/` — the TypeScript Mastra Code plugin (`codingbutter.desktop-control`)
- `client/` — the local hub's own surface. Today: signing in with your own Anthropic and OpenAI accounts
- `service/` — the Python desktop service, speaking AT-SPI2 over a Unix-socket JSON-RPC protocol
- `protocol/` — `schema.json`, the single source of truth for that protocol. The TypeScript and
  Python bindings are both generated from it, and neither is edited by hand
- `scripts/` — the binding generator, its regeneration check, and the scripts that produce proofs
- `docs/` — research findings, architecture, tool API, security model, prototype notes, the distribution ruling, the compatibility matrix, the open-questions log, and `docs/proofs/`

If you are picking up an issue, read [CONTRIBUTING.md](CONTRIBUTING.md) first — it is short, and
it is mostly about how to prove what you did from wherever you happen to be sitting. For depth,
[`protocol/README.md`](protocol/README.md) has the wire contract and what counts as a breaking
change, [`service/README.md`](service/README.md) has the threading contract and the `gi`
containment rule, and [`ROADMAP.md`](ROADMAP.md) has where the project is.

### Documentation set

| Document | What it covers |
|----------|----------------|
| [docs/01-research-findings.md](docs/01-research-findings.md) | AT-SPI2 research: the accessibility bus, tree traversal, querying, pointer-free actions, editable text, reference lifetimes, per-toolkit exposure |
| [docs/02-architecture-proposal.md](docs/02-architecture-proposal.md) | The load-bearing decision: why a signal provider that pushes deltas, not an MCP request/response server |
| [docs/03-tool-api.md](docs/03-tool-api.md) | Every method, parameter, and error code — generated from `protocol/schema.json` so it cannot drift |
| [docs/04-security-model.md](docs/04-security-model.md) | Operation classes, the ceiling-and-hand consent model, redaction, capture blocklist, holds, audit, emergency stop |
| [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md) | Measured accessibility-tree coverage across applications and toolkits |
| [docs/06-how-a-stranger-connects.md](docs/06-how-a-stranger-connects.md) | How a machine and a client find each other, and what the daemon deliberately does not own |
| [docs/07-open-questions.md](docs/07-open-questions.md) | Gaps this build does not close, and the deferred capability tiers |
| [docs/08-prototype-notes.md](docs/08-prototype-notes.md) | What proved out, what was harder than expected, and the lessons worth not rediscovering |
| [docs/proofs/](docs/proofs/) | Script-generated evidence about the real desktop — never hand-written |

Everything below runs from the repository root, in order, in one shell.

## Requirements

- Linux with an active AT-SPI2 accessibility bus (`at-spi2-registryd`)
- Node.js and pnpm
- Two apt packages, **installed before the virtualenv is created**:

```sh
sudo apt-get install -y python3-gi gir1.2-atspi-2.0 libx11-6
```

These are not optional, and not only for the tests that drive a real desktop.
`service/desktop_service/backends/atspi.py` imports `gi` at module scope, so without them
`pytest --no-live` does not fail a few tests — it collects none at all, and every file reports
`ModuleNotFoundError: No module named 'gi'`.

## Setup

```sh
# service toolchain — --system-site-packages is mandatory. A plain venv cannot see
# the gi/AT-SPI typelibs, and the failure reads exactly like not having installed them.
python3 -m venv --system-site-packages service/.venv
service/.venv/bin/pip install pytest

# plugin toolchain
pnpm -C plugin install
```

### Registering the plugin

The plugin runs from a **project-scoped local plugin registry** under `.mastracode/plugins/`,
which is git-ignored. A fresh clone has no registry record, so it must be recreated:

```sh
mkdir -p .mastracode/plugins/sources/local
ln -sfn ../../../../plugin .mastracode/plugins/sources/local/desktop-control
```

Then write `.mastracode/plugins/plugins.json`:

```json
{
  "plugins": {
    "desktop-control": {
      "enabled": true,
      "source": "local",
      "specifier": "plugin",
      "path": "sources/local/desktop-control",
      "entry": "src/index.ts"
    }
  },
  "disabledPlugins": []
}
```

The `path` is relative to the plugins directory, **not** the project root. The plugin source
itself stays in the tracked `plugin/` directory; the registry entry is a symlink to it.

## Running the service

```sh
( cd service && .venv/bin/python -m desktop_service --session dev )
```

The service is imported as a package from `service/`, so this one runs in a subshell — the
parentheses are what keep the directory change from leaking into whatever you paste next.

It prints `listening <socket path>` once it is ready, and holds the terminal. Add `--daemon` to
outlive the shell that started it; `--socket PATH` and `--config PATH` override the defaults.

A daemon is not immortal, and deliberately so. It exits shortly after its last client
disconnects, and exits on its own if nobody connects at all within half a minute — say so in
`stderr` either way, so an exit never reads as a crash. Nothing is interrupted: a daemon with a
client still attached stays up for as long as that client wants it, however long a write takes.

Clients never attach to a daemon running different code, because they cannot find one: the socket
name carries the schema digest (`daemon-<digest>.sock`), so a client whose generated protocol
differs looks for a path that does not exist and starts its own service. Two clients on the same
build still share one desktop. Regenerating the protocol therefore does not require remembering
to restart anything — the old daemon keeps serving whoever it already has, and goes away when
they let go.

## Tests

```sh
# the portable half: protocol, registry, delta engine, consent ceiling. No desktop needed.
service/.venv/bin/python -m pytest -q --no-live service/tests

# the half that drives whatever desktop session is actually logged in
service/.venv/bin/python -m pytest -q --live-only service/tests

# everything this machine can run
service/.venv/bin/python -m pytest -q service/tests

# the checked-in bindings still match protocol/schema.json
node scripts/generate-protocol.test.mjs
```

Any test module whose name ends in `_live` is marked live automatically, and anything else that
needs a desktop carries the marker itself. A machine with no reachable desktop deselects those
and says so, rather than failing in a way that reads like a regression — and the desktop is
probed by connecting to it, never by reading `DISPLAY`.

The plugin's own lanes are `pnpm -C plugin test` and `pnpm -C plugin typecheck`, and
`pnpm -C plugin install` is the only thing either one needs.

They can be run from a clone because the plugin declares the framework packages it imports:
`@mastra/core` supplies `InputProcessor` from `@mastra/core/processors` and `SignalProvider`
from `@mastra/core/signals`, and `@mastra/code-sdk` supplies `createTool`,
`defineMastraCodePlugin` and `z`. Both are also declared as peer dependencies, because at
runtime it is the **host** that owns them — a plugin is loaded into a running Mastra Code, not
run on its own, and a signal provider built from a second copy of `@mastra/core` is not the same
class as the one the host checks against. The local copies exist so the lanes can compile and
run; the host's copies are what the plugin is actually loaded with. Keep the two versions in
step, which is why they are pinned exactly rather than caret-ranged.

`plugin/src/dependencies.test.ts` enforces the property that made this section true: every
package imported anywhere under `plugin/src` must appear in `plugin/package.json`. An import
that resolves only because of something a developer arranged by hand fails that test.

There is also a third lane, `pnpm -C plugin test:gate`, holding tests that pin behaviour the
plugin depends on but does not own. Per [CONTRIBUTING.md](CONTRIBUTING.md), a failure there is a
signal to investigate, not a reason to block a PR.

The client has the same two lanes on its own package: `pnpm -C client test` and
`pnpm -C client typecheck`, after `pnpm -C client install`. Its suite needs no network and no
desktop — the provider login flows are mocked, because our half of an OAuth exchange is the half
worth testing, while the credential store is the SDK's real `AuthStorage` writing a real
`auth.json` into a temporary directory, so "the credential persisted" means the file rather than
a spy that agreed it was called.
