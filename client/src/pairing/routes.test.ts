/**
 * The pairing doors, asserted from the outside.
 *
 * The properties under test are the ones that decide whether this ceremony is
 * safe to ship: minting is local-only, redeeming spends the ticket once, the
 * secret is returned exactly once and by no other route, and revocation is
 * reachable from the machine rather than from the phone that was lost.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICES_PATH, buildDevicesApp } from "../devices/index.ts";
import type { DevicesView } from "../devices/index.ts";
import { createDeviceCredentialStore } from "../events/index.ts";
import type { DeviceCredentialStore } from "../events/index.ts";
import {
  PAIRING_REDEEM_PATH,
  PAIRING_TICKET_PATH,
  buildPairingApp,
} from "./routes.ts";
import { createTicketMint } from "./tickets.ts";

/** The env shape `getConnInfo` reads: the kernel's account of the peer. */
const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const REMOTE = { incoming: { socket: { remoteAddress: "192.168.1.44" } } };

let dir: string;
let store: DeviceCredentialStore;
let app: ReturnType<typeof buildPairingApp>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pairing-"));
  store = createDeviceCredentialStore(path.join(dir, "device-credentials.json"));
  app = buildPairingApp({ tickets: createTicketMint(), credentials: store });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ask for a code the way the dashboard on this machine does. */
async function issue(): Promise<string> {
  const response = await app.request(PAIRING_TICKET_PATH, { method: "POST" }, LOCAL);
  expect(response.status).toBe(200);
  return ((await response.json()) as { code: string }).code;
}

/** Redeem the way a phone does: from the network, holding nothing but the code. */
function redeem(code: string, label = "Jamie's phone") {
  return app.request(
    PAIRING_REDEEM_PATH,
    {
      method: "POST",
      body: JSON.stringify({ code, label }),
      headers: { "content-type": "application/json" },
    },
    REMOTE,
  );
}

describe("issuing a pairing code", () => {
  it("is refused over the network, because the code is the consent", async () => {
    // A mint reachable from the network would be a lock that hands out its own
    // keys: the whole story is that someone sitting at this machine pressed a
    // button and a QR appeared on their screen.
    const response = await app.request(PAIRING_TICKET_PATH, { method: "POST" }, REMOTE);

    expect(response.status).toBe(403);
  });

  it("carries an expiry, so the card can say when the code dies", async () => {
    const response = await app.request(PAIRING_TICKET_PATH, { method: "POST" }, LOCAL);
    const body = (await response.json()) as { code: string; expiresAt: number };

    expect(body.code).toBeTruthy();
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("redeeming a pairing code", () => {
  it("turns a stranger into a device, once", async () => {
    const code = await issue();

    const first = await redeem(code);
    expect(first.status).toBe(200);
    const credential = (await first.json()) as { id: string; secret: string; label: string };
    expect(credential.label).toBe("Jamie's phone");

    // The ticket is spent. A second phone cannot ride one ceremony.
    const second = await redeem(code, "A second phone");
    expect(second.status).toBe(403);
  });

  it("mints a credential the events door actually accepts", async () => {
    const code = await issue();
    const credential = (await (await redeem(code)).json()) as { id: string; secret: string };

    // The point of the whole exercise: pairing mints into the lock that already
    // existed, so the phone's credential opens the door without a second way in.
    await expect(store.verify(`comcon-device.${credential.id}.${credential.secret}`)).resolves.toBe(
      true,
    );
    await expect(store.verify(`comcon-device.${credential.id}.wrong`)).resolves.toBe(false);
  });

  it("refuses a wrong code and a spent one identically", async () => {
    const code = await issue();
    await redeem(code);

    const wrong = await redeem("not-a-real-code");
    const spent = await redeem(code);

    expect(wrong.status).toBe(spent.status);
    expect(await wrong.json()).toEqual(await spent.json());
  });

  it("bounds the label a phone offers rather than trusting it", async () => {
    const code = await issue();
    await redeem(code, "  A phone\nThis machine  ");

    const [device] = await store.list();
    // A newline is how one row becomes two in anything rendering a list.
    expect(device?.label).toBe("A phone This machine");
  });
});

describe("what pairing never does", () => {
  it("returns the secret once and from no other route", async () => {
    const code = await issue();
    await redeem(code);

    // The device list is the surface a page reads. It must never carry a secret,
    // and the type omits it so this cannot regress quietly.
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret");

    const devices = buildDevicesApp({ faces: () => 0, paired: () => store.list() });
    const raw = await (await devices.request(DEVICES_PATH)).text();
    const stored = JSON.parse(
      await readFile(path.join(dir, "device-credentials.json"), "utf8"),
    ) as { devices: { secret: string }[] };

    expect(raw).not.toContain(stored.devices[0]!.secret);
  });

  it("writes the store so only this user can read it", async () => {
    const code = await issue();
    await redeem(code);

    const { stat } = await import("node:fs/promises");
    const mode = (await stat(path.join(dir, "device-credentials.json"))).mode & 0o777;
    // What may open a window onto this machine's spoken conversation is nobody
    // else's business — same posture as the daemon socket.
    expect(mode).toBe(0o600);
  });
});

describe("revoking a pairing", () => {
  it("is done from the machine, not from the phone that was lost", async () => {
    const code = await issue();
    const credential = (await (await redeem(code)).json()) as { id: string };

    const fromPhone = await app.request(
      `/api/pairing/devices/${credential.id}`,
      { method: "DELETE" },
      REMOTE,
    );
    expect(fromPhone.status).toBe(403);
    // Still paired: the refusal was real, not cosmetic.
    expect(await store.list()).toHaveLength(1);

    const fromMachine = await app.request(
      `/api/pairing/devices/${credential.id}`,
      { method: "DELETE" },
      LOCAL,
    );
    expect(fromMachine.status).toBe(200);
    expect(await store.list()).toHaveLength(0);
  });

  it("shuts the door the credential opened", async () => {
    const code = await issue();
    const credential = (await (await redeem(code)).json()) as { id: string; secret: string };
    const presented = `comcon-device.${credential.id}.${credential.secret}`;

    await expect(store.verify(presented)).resolves.toBe(true);
    await app.request(`/api/pairing/devices/${credential.id}`, { method: "DELETE" }, LOCAL);
    // Revocation that left the door open would be a button that lies.
    await expect(store.verify(presented)).resolves.toBe(false);
  });

  it("treats revoking twice as the state the caller asked for", async () => {
    const code = await issue();
    const credential = (await (await redeem(code)).json()) as { id: string };
    const url = `/api/pairing/devices/${credential.id}`;

    expect(await (await app.request(url, { method: "DELETE" }, LOCAL)).json()).toEqual({
      revoked: true,
    });
    expect(await (await app.request(url, { method: "DELETE" }, LOCAL)).json()).toEqual({
      revoked: false,
    });
  });
});

describe("the devices page, once a phone is paired", () => {
  it("gains a removable row that names no address", async () => {
    const code = await issue();
    await redeem(code, "Jamie's phone");

    const devices = buildDevicesApp({ faces: () => 0, paired: () => store.list() });
    const response = await devices.request(DEVICES_PATH);
    const body = (await response.json()) as DevicesView;

    const phone = body.devices.find((device) => device.kind === "paired");
    expect(phone?.name).toBe("Jamie's phone");
    // The first row that is legitimately removable — revoking a pairing is a
    // real action, which is why this machine and the widget are not.
    expect(phone?.removable).toBe(true);
    expect(body.devices.find((device) => device.kind === "hub")?.removable).toBe(false);
    expect(body.pairing.enabled).toBe(true);

    // The no-fingerprinting property holds through this change.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(raw).not.toMatch(/\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/i);
  });
});
