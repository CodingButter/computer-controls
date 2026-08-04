# client — the local hub

One process on your own machine: a headless Mastra Code agent, the desktop
plugin mounted into it, and a chat page served from the same port. No sandbox
fleet, no tenant, no auth adapter. The agent runs where the desktop is, and the
only thing standing between a stranger and your desktop is that the port is
bound to loopback.

```
pnpm install
pnpm start          # http://127.0.0.1:4111
```

Sign in first with the Mastra Code TUI — the hub reads the same file-backed
credential store (`auth.json`), so a machine that can run the TUI can run this.

## Knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `COMCON_CLIENT_HOST` | `127.0.0.1` | Bind address. Changing this publishes an agent that holds your desktop; nothing downstream will refuse. |
| `COMCON_CLIENT_PORT` | `4111` | Port. `0` lets the OS pick, which is how the tests boot it. |
| `COMCON_CLIENT_ROOT` | this package | Where config, plugins, and the database live. |
| `COMCON_DESKTOP_PLUGIN_PATH` | `../plugin` | The desktop-control package to mount. |
| `COMCON_DESKTOP_SCOPE` | `observe` | Operation classes the desktop plugin may mint tools for. |
| `COMCON_PLUGIN_HOME` | your home | Where the hub looks for plugins already installed on this machine. |
| `COMCON_PLUGIN_ALLOWLIST` | — | Extra plugin ids to admit, comma-separated. Extends the built-in list; cannot empty it. |

The scope is written into the plugin registry on every boot, so the door the
agent finds is the one this process configured — not one a previous run left
open. At `observe` the agent can read the desktop and nothing else: tools above
that class are absent, not merely disabled.

## Plugins are admitted, not inherited

The coding runtime resolves plugins from the project it is pointed at *and* from
your home directory, which would hand a session that holds your desktop every
plugin you ever installed for your terminal. The hub reads those registries as
candidates instead and mounts its own list: the desktop plugin, memory, and
whatever `COMCON_PLUGIN_ALLOWLIST` adds. Everything else is absent — not
disabled, never loaded, nothing to switch back on from inside a chat.

Admission is not exemption. An admitted plugin still passes the same strip on
the way to the session, so one that mints a tool called `execute_command` hands
over nothing. `GET /api/health` reports what was admitted and what was found and
refused; a plugin in neither list is one that is not installed here.

## Shape

| File | Holds |
| --- | --- |
| `src/index.ts` | The entry. Constructs `new Mastra(...)` as a literal export, because the deployer's Babel plugin only recognises a config it can find in the AST. |
| `src/hub.ts` | Assembly: admit the plugins, prepare the controller mount, mint the browser's session, build the chat turn. |
| `src/chat.ts` | One turn: a message in, the agent's answer out, over the headless `runMC` API. |
| `src/app.ts` | Three routes — health, chat, and the page. |
| `src/ui.ts` | The static lane: one directory served as an SPA, with anything that escapes it refused. |
| `src/plugins.ts` | The allowlist: reads what is installed on the machine, mounts only what is admitted. |
| `src/desktop-plugin.ts` | The desktop plugin's registry record, at the configured scope. |

## Tests

```
pnpm test           # portable: boots the hub, serves the page, runs a turn
pnpm test:gate      # spends a real credential on a real model
pnpm typecheck
```

The portable lane boots the hub for real and drives it over HTTP. It replaces
exactly one thing — the model call — because a model needs a credential this
lane does not have. The turn that reaches a real model lives in
`src/chat-model.gate.test.ts` and is excluded from the default run, the same way
the plugin's gate tests are.
