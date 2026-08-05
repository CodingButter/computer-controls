import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, describe } from "vitest";

import {
  DEVICE_SUBPROTOCOL_PREFIX,
  MalformedDeviceCredentials,
  createDeviceCredentialStore,
  type DeviceCredentialStore,
} from "./device-credentials.ts";

let dir: string;
let file: string;
let store: DeviceCredentialStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "comcon-devices-"));
  file = path.join(dir, "device-credentials.json");
  store = createDeviceCredentialStore(file);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What a paired device would actually put on the wire. */
const presented = (id: string, secret: string) => `${DEVICE_SUBPROTOCOL_PREFIX}${id}.${secret}`;

describe("the device credential store", () => {
  test("a minted credential verifies, and survives a process restart", async () => {
    const minted = await store.mint("Jamie's phone");
    expect(await store.verify(presented(minted.id, minted.secret))).toBe(true);

    // A different instance over the same file — the restart case. The store
    // is the file, not the object.
    const reopened = createDeviceCredentialStore(file);
    expect(await reopened.verify(presented(minted.id, minted.secret))).toBe(true);
  });

  test("a wrong secret and a well-formed unknown credential refuse identically", async () => {
    const minted = await store.mint("Jamie's phone");
    // Same verdict, same shape, whichever part of the guess was wrong. A
    // caller must not learn whether an id exists from how it was refused.
    const wrongSecret = await store.verify(presented(minted.id, "0".repeat(64)));
    const unknownDevice = await store.verify(presented("feedfacefeedface", "0".repeat(64)));
    expect(wrongSecret).toBe(false);
    expect(unknownDevice).toBe(false);
  });

  test("shapes that are not even credentials refuse without error", async () => {
    await store.mint("Jamie's phone");
    for (const junk of [
      "",
      "comcon-device.",
      "comcon-device.id-only",
      "comcon-device..secret",
      "comcon-device.id.",
      "graphql-ws",
      "comcon-device", // prefix without its dot
    ]) {
      expect(await store.verify(junk)).toBe(false);
    }
  });

  test("an absent file is an empty store, not an error", async () => {
    expect(await store.verify(presented("anything", "at-all"))).toBe(false);
  });

  test("minting keeps what it did not write", async () => {
    // Read-modify-write: a key a newer version added must survive an older
    // version minting. The same discipline settings.json lives under.
    await writeFile(file, `${JSON.stringify({ someFutureKey: { kept: true } })}\n`, "utf8");
    const minted = await store.mint("Jamie's phone");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.someFutureKey).toEqual({ kept: true });
    expect(await store.verify(presented(minted.id, minted.secret))).toBe(true);
  });

  test("two mints are two devices, both admitted", async () => {
    const phone = await store.mint("Jamie's phone");
    const laptop = await store.mint("minibeast");
    expect(phone.id).not.toBe(laptop.id);
    expect(phone.secret).not.toBe(laptop.secret);
    expect(await store.verify(presented(phone.id, phone.secret))).toBe(true);
    expect(await store.verify(presented(laptop.id, laptop.secret))).toBe(true);
  });

  test("a malformed store refuses the mint by name instead of writing over it", async () => {
    // Reading a typo as "no devices" and then saving would vanish every
    // paired device at once, silently. The mint refuses loudly instead.
    await writeFile(file, "{ not json", "utf8");
    await expect(store.mint("Jamie's phone")).rejects.toBeInstanceOf(MalformedDeviceCredentials);
    expect(await readFile(file, "utf8")).toBe("{ not json");

    await writeFile(file, `${JSON.stringify({ devices: [{ id: "x" }] })}`, "utf8");
    await expect(store.mint("Jamie's phone")).rejects.toBeInstanceOf(MalformedDeviceCredentials);
  });

  test("a malformed store admits nobody at the door", async () => {
    // The door has no person to hear an error — it just stays shut.
    await writeFile(file, "{ not json", "utf8");
    expect(await store.verify(presented("any", "thing"))).toBe(false);
  });

  test("secrets look like secrets", async () => {
    const minted = await store.mint("Jamie's phone");
    // 32 random bytes as hex. Not a UUID, not a timestamp, not guessable.
    expect(minted.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
