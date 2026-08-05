/** /api/devices — what is talking to this hub. */

import { fetchJson, type Fetched } from "./core";

/**
 * One thing connected to the hub, in the hub's own words.
 *
 * `detail` is a sentence written by the hub, not a status code the page
 * decorates: the hub is the only side that knows why a row reads the way it
 * does, and a page that re-phrased it would be inventing a second answer.
 */
export type DeviceView = {
  kind: string;
  name: string;
  connected: boolean;
  detail: string;
  removable: boolean;
};

/**
 * Pairing is a capability with a reason arm, like voice and the orb: it is off
 * until the phone client exists, and the hub says so in a sentence rather than
 * leaving a dead button on the page.
 */
export type PairingStatus = { enabled: true } | { enabled: false; reason: string };

export type DevicesView = {
  devices: readonly DeviceView[];
  pairing: PairingStatus;
};

function parseDevice(value: unknown): DeviceView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string") return undefined;
  return {
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    name: raw.name,
    connected: raw.connected === true,
    detail: typeof raw.detail === "string" ? raw.detail : "",
    removable: raw.removable === true,
  };
}

function parsePairing(value: unknown): PairingStatus {
  if (typeof value !== "object" || value === null || !("enabled" in value)) {
    return { enabled: false, reason: "This hub did not say whether pairing is available." };
  }
  const raw = value as Record<string, unknown>;
  if (raw.enabled === true) return { enabled: true };
  return {
    enabled: false,
    reason: typeof raw.reason === "string" ? raw.reason : "Pairing is not available.",
  };
}

export function parseDevices(body: unknown): DevicesView {
  if (typeof body !== "object" || body === null || !("devices" in body)) {
    throw new Error("not a devices response");
  }
  const raw = body as Record<string, unknown>;
  const devices = Array.isArray(raw.devices)
    ? raw.devices.map(parseDevice).filter((row): row is DeviceView => row !== undefined)
    : [];
  return { devices, pairing: parsePairing(raw.pairing) };
}

export function getDevices(): Promise<Fetched<DevicesView>> {
  return fetchJson("/api/devices", parseDevices);
}
