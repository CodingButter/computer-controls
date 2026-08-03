# computer-controls

A Mastra Code plugin that gives a coding agent a **semantic** interface to a Linux desktop —
applications, windows, dialogs, buttons, text fields — instead of screenshots, OCR and
coordinate guessing.

- `plugin/` — the TypeScript Mastra Code plugin (`codingbutter.desktop-control`)
- `service/` — the Python desktop service, speaking AT-SPI2 over a Unix-socket JSON-RPC protocol
- `protocol/` — `schema.json`, the single source of truth for that protocol. The TypeScript and
  Python bindings are both generated from it, and neither is edited by hand
- `scripts/` — the binding generator, its regeneration check, and the scripts that produce proofs
- `docs/` — the compatibility matrix, the distribution ruling, the open-questions log, and `docs/proofs/`

If you are picking up an issue, read [CONTRIBUTING.md](CONTRIBUTING.md) first — it is short, and
it is mostly about how to prove what you did from wherever you happen to be sitting. For depth,
[`protocol/README.md`](protocol/README.md) has the wire contract and what counts as a breaking
change, [`service/README.md`](service/README.md) has the threading contract and the `gi`
containment rule, and [`ROADMAP.md`](ROADMAP.md) has where the project is.

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

Clients attach to a service that is already running and never start one, which makes a stale
daemon worth knowing about in advance: it serves the code it booted with, so after regenerating
the protocol or editing the service, **restart it**. A daemon still running the previous schema
answers `METHOD_NOT_FOUND` for methods the current bindings promise. Both halves carry a schema
digest so the mismatch can be seen rather than guessed at — see
[CONTRIBUTING.md](CONTRIBUTING.md).

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
