/**
 * The credentials a paired device presents at the lane's door.
 *
 * Today the `/events` upgrade admits loopback, which is the kernel vouching
 * for a process on this machine. That answer stops working the moment the
 * product's remote story arrives: QR pairing (#35) will hand a phone or
 * another machine something to present, and this store is the something. The
 * check exists now so the socket's security story stops being "loopback" —
 * pairing later mints entries here and nothing about the door reshapes.
 *
 * The credential travels as a WebSocket subprotocol,
 * `comcon-device.<id>.<secret>`, and not as a query parameter — a token in a
 * URL is a token in every access log, browser history, and proxy line on the
 * path. A subprotocol still rides the upgrade headers in the clear, which is
 * only defensible under TLS or on loopback; the hub binds `127.0.0.1` and its
 * one public door is a TLS proxy, and this comment exists so the bind can
 * never widen silently past that assumption.
 *
 * Secrets are crypto-random, never logged, and never returned by any route.
 * There is deliberately no minting route yet: the pairing flow is the minting
 * UI, and a mint reachable over plain HTTP before pairing's consent ceremony
 * exists would be an open door wearing a lock.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Beside `settings.json` under the hub's own config dir. Both .gitignore spellings exist. */
export const DEVICE_CREDENTIALS_FILE = "device-credentials.json";

/** What a device offers in `Sec-WebSocket-Protocol`. */
export const DEVICE_SUBPROTOCOL_PREFIX = "comcon-device.";

export type DeviceCredential = {
  id: string;
  secret: string;
  /** Human words for the pairing UI — "Jamie's phone" — never checked. */
  label: string;
  createdAt: string;
};

/**
 * A store that exists but cannot be read as one.
 *
 * Its own class for the same reason `MalformedConfig` is: absence is safe and
 * yields an empty store, whereas a file with content that does not parse must
 * refuse loudly rather than be read as empty — reading a typo as "no devices"
 * and then writing over it is how every paired device vanishes at once.
 */
export class MalformedDeviceCredentials extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedDeviceCredentials";
  }
}

type StoreDocument = Record<string, unknown>;

function isCredential(value: unknown): value is DeviceCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.secret === "string" &&
    entry.secret !== "" &&
    typeof entry.label === "string" &&
    typeof entry.createdAt === "string"
  );
}

/**
 * Read the store, or the safe empty one.
 *
 * The whole document comes back, not just the devices, because the write path
 * is read-modify-write: a key a newer version added must survive an older
 * version minting a credential.
 */
async function readStore(file: string): Promise<{ document: StoreDocument; devices: DeviceCredential[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { document: {}, devices: [] };
    throw error;
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(text);
  } catch (error) {
    throw new MalformedDeviceCredentials(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new MalformedDeviceCredentials(`${file} must contain a JSON object`);
  }
  const document = loaded as StoreDocument;
  const devices = document.devices;
  if (devices === undefined) return { document, devices: [] };
  if (!Array.isArray(devices) || !devices.every(isCredential)) {
    throw new MalformedDeviceCredentials(`${file}: "devices" must be a list of credentials`);
  }
  return { document, devices };
}

/**
 * Temp file then rename — atomic within a directory on POSIX, mode 0600 like
 * the daemon socket, for the same reason: what may open a window onto this
 * machine's spoken conversation is nobody else's business.
 */
async function writeStore(file: string, document: StoreDocument): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

/**
 * Split a presented subprotocol into its parts, or nothing.
 *
 * Ids are minted as hex so the first dot after the prefix is unambiguous. A
 * string that is not even the right shape returns undefined — and the caller
 * still runs a comparison, so a malformed offering costs the same time as a
 * wrong one.
 */
function parsePresented(presented: string): { id: string; secret: string } | undefined {
  if (!presented.startsWith(DEVICE_SUBPROTOCOL_PREFIX)) return undefined;
  const rest = presented.slice(DEVICE_SUBPROTOCOL_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  return { id: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

/** Hashing first makes the buffers equal-length, which `timingSafeEqual` requires. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export type DeviceCredentialStore = {
  /** Create and persist a credential. The pairing flow is the only intended caller. */
  mint(label: string): Promise<DeviceCredential>;
  /** Whether a presented subprotocol names a credential this hub minted. */
  verify(presented: string): Promise<boolean>;
};

export function createDeviceCredentialStore(file: string): DeviceCredentialStore {
  return {
    async mint(label: string): Promise<DeviceCredential> {
      const credential: DeviceCredential = {
        id: randomBytes(8).toString("hex"),
        secret: randomBytes(32).toString("hex"),
        label,
        createdAt: new Date().toISOString(),
      };
      const { document, devices } = await readStore(file);
      await writeStore(file, { ...document, devices: [...devices, credential] });
      return credential;
    },

    async verify(presented: string): Promise<boolean> {
      const parsed = parsePresented(presented);
      let devices: DeviceCredential[];
      try {
        ({ devices } = await readStore(file));
      } catch {
        // A store that cannot be read admits nobody. The malformed-file error
        // is for the minting path, where a person is there to hear it; the
        // door just stays shut.
        return false;
      }
      const entry = parsed ? devices.find((device) => device.id === parsed.id) : undefined;
      // One comparison on every path. An unknown id compares a random dummy so
      // that "no such device" and "wrong secret" cost the same time and refuse
      // identically — a caller timing the door learns nothing about which part
      // of its guess was wrong.
      const expected = entry ? digest(entry.secret) : digest(randomBytes(32).toString("hex"));
      const offered = digest(parsed ? parsed.secret : "");
      return timingSafeEqual(expected, offered) && entry !== undefined;
    },
  };
}
