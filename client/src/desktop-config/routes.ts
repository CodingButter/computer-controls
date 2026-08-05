/**
 * The hub's one door onto the user's desktop configuration.
 *
 * The Settings page's three depths — Easy, Standard, Advanced — are lenses over
 * one object, so they are lenses over one route. Easy is not a smaller API with
 * fewer fields; it is this response with fewer fields drawn. That is the
 * difference between three depths and three products, and putting it in the
 * transport is what stops the drift: there is no per-lens endpoint that could
 * grow a key the other lenses cannot see, and no lens can save a value another
 * lens would have had to discard.
 *
 * The response carries the daemon's defaults alongside the file's contents,
 * because a lens that draws an empty box for an unset key is lying about what
 * the daemon will do with it. Unset does not mean nothing; it means 30 minutes,
 * or observe-only, or audit on.
 *
 * There are no secrets here to leak. Provider credentials live in the SDK's
 * `auth.json` behind the sign-in routes and never appear in this file, so
 * Advanced can render the whole object verbatim — which is the only way
 * Advanced can honestly claim to be showing the whole object.
 */

import { Hono } from "hono";

import {
  MalformedConfig,
  OPERATION_CLASSES,
  PERMISSIONS_MODES,
  SETTINGS_KEYS,
  mergeSettings,
  readConfigFile,
  writeConfigFile,
  type ConfigObject,
} from "./config-file.ts";

export const DESKTOP_CONFIG_PATH = "/api/desktop-config";

export type DesktopConfigMount = {
  /**
   * Which file to read and write. Passed in rather than resolved here: where
   * this machine keeps a config directory is the platform adapter's answer, and
   * a route that worked it out for itself would be a second opinion about the
   * one file the daemon reads. It also lets the tests exercise the real
   * read-merge-write path against a temporary directory rather than a mock —
   * the atomicity and the unknown-key preservation are the whole feature, and
   * neither can be proven against a fake filesystem.
   */
  file: string;
};

/**
 * What every lens is told. Deliberately one shape for all three depths.
 */
export type DesktopConfigView = {
  config: ConfigObject;
  exists: boolean;
  /** Shown by Advanced, because a person editing their ceiling should know which file they are editing. */
  path: string;
  /** The keys this surface may write. Anything else in `config` is displayed and left alone. */
  owns: readonly string[];
  /** What the daemon uses for a key the file does not set. */
  defaults: {
    permissionsMode: string;
    operationClasses: string[];
    confirmClasses: string[];
    idleExpirySeconds: number;
    audit: boolean;
  };
  /** The vocabularies, so a lens offers exactly the values the daemon accepts. */
  vocabulary: {
    permissionsModes: readonly string[];
    operationClasses: readonly string[];
  };
};

/**
 * `security.py`'s defaults, mirrored: `DEFAULT_CLASSES`, `CONFIRM_BY_DEFAULT`,
 * `DEFAULT_IDLE_EXPIRY_SECONDS`, `OPEN_MODE`, and the audit log's own default.
 */
const DAEMON_DEFAULTS: DesktopConfigView["defaults"] = {
  permissionsMode: "open",
  operationClasses: ["observe"],
  confirmClasses: ["submit", "destructive"],
  idleExpirySeconds: 30 * 60,
  audit: true,
};

export function buildDesktopConfigApp(mount: DesktopConfigMount): Hono {
  const app = new Hono();
  const { file } = mount;

  app.get(DESKTOP_CONFIG_PATH, async (c) => {
    try {
      const { config, exists } = await readConfigFile(file);
      return c.json(view(config, exists, file));
    } catch (error) {
      if (error instanceof MalformedConfig) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.put(DESKTOP_CONFIG_PATH, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const edits = (body as { edits?: unknown } | undefined)?.edits;
    if (edits === null || typeof edits !== "object" || Array.isArray(edits)) {
      return c.json({ error: "edits must be an object of setting keys" }, 400);
    }

    let current: Awaited<ReturnType<typeof readConfigFile>>;
    try {
      current = await readConfigFile(file);
    } catch (error) {
      if (error instanceof MalformedConfig) {
        // The refusal a save must end in when the file on disk cannot be read.
        // Merging into `{}` here would be the silent overwrite: one trailing
        // comma, and a hand-written allowlist is gone with a success message.
        return c.json({ error: `${error.message}. Nothing was written.` }, 409);
      }
      throw error;
    }

    const merged = mergeSettings(current.config, edits as ConfigObject);
    if (!merged.ok) return c.json({ error: merged.reason }, 400);

    await writeConfigFile(file, merged.config);
    return c.json(view(merged.config, true, file));
  });

  return app;
}

function view(config: ConfigObject, exists: boolean, file: string): DesktopConfigView {
  return {
    config,
    exists,
    path: file,
    owns: SETTINGS_KEYS,
    defaults: DAEMON_DEFAULTS,
    vocabulary: {
      permissionsModes: PERMISSIONS_MODES,
      operationClasses: OPERATION_CLASSES,
    },
  };
}
