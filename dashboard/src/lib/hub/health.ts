/** /api/health and /api/orb/status — what the overview cards are made of. */

import { asStringArray, fetchJson, type Fetched } from "./core";

/** What /api/health reports about a voice- or orb-shaped capability. */
export type CapabilityStatus =
  | { enabled: true }
  | { enabled: false; reason: string };

export type ModelPack = {
  pack: string;
  thinking?: string;
  tiers: Record<string, string>;
};

/**
 * A plugin the hub found installed and did not mount.
 *
 * The reason is optional because today's hub reports refusals as bare ids. A
 * refusal without a reason is a defect worth showing rather than hiding, so
 * the shape keeps the gap visible instead of inventing a sentence for it —
 * and reads the reason the day the hub starts sending one.
 */
export type RefusedPlugin = { name: string; reason?: string };

export type HubHealth = {
  ok: boolean;
  tools: readonly string[];
  desktopScope?: string;
  plugins: { admitted: readonly string[]; refused: readonly RefusedPlugin[] };
  model?: ModelPack;
  voice?: CapabilityStatus;
  orb?: CapabilityStatus;
};

/**
 * /api/orb/status — the refused shape carries the reason a person should see.
 *
 * Since the hub went deaf the enabled shape is deliberately coarse: idle or
 * talking, and how many client mouths hold an open voice session. The gate
 * and the ear languages the old shape reported live on the devices now, so a
 * hub that claimed to know them would be lying.
 */
export type OrbStatus =
  | { enabled: true; state: string; mouths: number }
  | { enabled: false; reason: string };

/**
 * Parse without trusting: the hub is ours, but a half-started hub or a proxy
 * error page should read as unreachable, not as a crash in the render.
 */
export function parseHealth(body: unknown): HubHealth {
  if (typeof body !== "object" || body === null || !("ok" in body)) {
    throw new Error("not a health response");
  }
  const raw = body as Record<string, unknown>;
  const plugins =
    typeof raw.plugins === "object" && raw.plugins !== null
      ? (raw.plugins as Record<string, unknown>)
      : {};
  return {
    ok: raw.ok === true,
    tools: asStringArray(raw.tools),
    desktopScope: typeof raw.desktopScope === "string" ? raw.desktopScope : undefined,
    plugins: {
      admitted: asStringArray(plugins.admitted),
      refused: parseRefused(plugins.refused),
    },
    model: parseModel(raw.model),
    voice: parseCapability(raw.voice),
    orb: parseCapability(raw.orb),
  };
}

/**
 * Refusals, whether the hub names them or explains them.
 *
 * A bare id is the shape the hub sends today; an object with a reason is the
 * shape it may send later. An entry that is neither is dropped, because a row
 * with no name is nothing a person can act on.
 */
function parseRefused(value: unknown): readonly RefusedPlugin[] {
  if (!Array.isArray(value)) return [];
  const refused: RefusedPlugin[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      refused.push({ name: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name : typeof raw.id === "string" ? raw.id : undefined;
    if (name === undefined) continue;
    refused.push(typeof raw.reason === "string" ? { name, reason: raw.reason } : { name });
  }
  return refused;
}

function parseModel(value: unknown): ModelPack | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.pack !== "string") return undefined;
  const tiers: Record<string, string> = {};
  if (typeof raw.tiers === "object" && raw.tiers !== null) {
    for (const [tier, model] of Object.entries(raw.tiers)) {
      if (typeof model === "string") tiers[tier] = model;
    }
  }
  return {
    pack: raw.pack,
    thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
    tiers,
  };
}

function parseCapability(value: unknown): CapabilityStatus | undefined {
  if (typeof value !== "object" || value === null || !("enabled" in value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.enabled === true) return { enabled: true };
  return { enabled: false, reason: typeof raw.reason === "string" ? raw.reason : "disabled" };
}

export function parseOrbStatus(body: unknown): OrbStatus {
  if (typeof body !== "object" || body === null || !("enabled" in body)) {
    throw new Error("not an orb status response");
  }
  const raw = body as Record<string, unknown>;
  if (raw.enabled === true) {
    return {
      enabled: true,
      state: typeof raw.state === "string" ? raw.state : "unknown",
      mouths: typeof raw.mouths === "number" ? raw.mouths : 0,
    };
  }
  return { enabled: false, reason: typeof raw.reason === "string" ? raw.reason : "disabled" };
}

export function getHealth(): Promise<Fetched<HubHealth>> {
  return fetchJson("/api/health", parseHealth);
}

export function getOrbStatus(): Promise<Fetched<OrbStatus>> {
  return fetchJson("/api/orb/status", parseOrbStatus);
}
