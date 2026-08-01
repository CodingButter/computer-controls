# computer-controls

A Mastra Code plugin that gives a coding agent a **semantic** interface to a Linux desktop —
applications, windows, dialogs, buttons, text fields — instead of screenshots, OCR and
coordinate guessing.

- `plugin/` — the TypeScript Mastra Code plugin (`codingbutter.desktop-control`)
- `service/` — the Python desktop service, speaking AT-SPI2 over a Unix-socket JSON-RPC protocol

Full documentation lands at the end of the project. What follows is the minimum needed to run
this from a fresh clone.

## Local development setup

The plugin runs from a **project-scoped local plugin registry** that lives under
`.mastracode/plugins/`, which is git-ignored. A fresh clone therefore has neither the registry
record nor the symlinks, and they must be recreated:

```sh
# plugin toolchain
cd plugin && pnpm install

# service toolchain — the --system-site-packages flag is mandatory,
# a plain venv cannot import the gi/AT-SPI typelibs
cd service && python3 -m venv --system-site-packages .venv && .venv/bin/pip install pytest

# register the plugin with Mastra Code (from the repository root)
mkdir -p .mastracode/plugins/sources/local plugin/node_modules
ln -sfn ../../../../plugin .mastracode/plugins/sources/local/desktop-control
ln -sfn /home/codingbutter/mastra-plugin-processors/mastracode/tui plugin/node_modules/mastracode
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

## Requirements

- Linux with an active AT-SPI2 accessibility bus (`at-spi2-registryd`)
- `python3-gi` and `gir1.2-atspi-2.0`
- Node.js and pnpm
