import { freedesktopPlatform } from "./freedesktop/index.ts";
import type { HubPlatform, PlatformId } from "./ports.ts";
import { macosPlatform, platformIdFor, windowsPlatform } from "./unimplemented.ts";

export type {
  ApplicationIcon,
  Autostart,
  AutostartEntry,
  HubPaths,
  HubPlatform,
  IconSource,
  InstalledApplication,
  PlatformId,
  PlatformSupport,
  ScanInstalled,
} from "./ports.ts";
export { platformIdFor } from "./unimplemented.ts";

/**
 * The one place the hub decides which OS it is running on.
 *
 * Every other module takes the resolved `HubPlatform` as a dependency, so
 * "which OS" is answered once, at boot, and a test can hand any module a
 * different adapter without owning a second machine. If a `process.platform`
 * check appears anywhere else in the client, it is a bug and belongs here.
 */
export function resolveHubPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | PlatformId = process.platform,
): HubPlatform {
  const id: PlatformId =
    platform === "freedesktop" || platform === "macos" || platform === "windows"
      ? platform
      : platformIdFor(platform);
  if (id === "macos") return macosPlatform(env);
  if (id === "windows") return windowsPlatform(env);
  return freedesktopPlatform(env);
}
