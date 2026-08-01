/**
 * Assembly point for the push lane.
 *
 * One provider instance per plugin load, shared by the signal-provider lane and
 * the arming processor — two of them would mean one subscribed provider and one
 * polling provider that never learned a thread existed.
 */
import type { InputProcessor } from "mastracode/plugin";

import { DesktopSignalProvider } from "./desktop-signal-provider.ts";
import { buildArmingProcessor } from "./processor.ts";
import { serviceSource, type ServiceHandle } from "./source.ts";

export interface PushLane {
  provider: DesktopSignalProvider;
  processors: InputProcessor[];
}

export function buildPushLane(service: ServiceHandle): PushLane {
  const provider = new DesktopSignalProvider({ source: serviceSource(service) });
  return { provider, processors: [buildArmingProcessor(provider)] };
}
