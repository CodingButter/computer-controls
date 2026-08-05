import fs from "node:fs";
import path from "node:path";

import type { WorkspaceSkillExtension } from "@mastra/code-sdk/agents/workspace";
import type { SkillSource } from "@mastra/core/workspace";

/**
 * The read side of the commons: merged skills, on the hub's session, as skills.
 *
 * The runtime already discovers skills, from three places — the project's own
 * config directory, the operator's home directory, and any a plugin declares.
 * None of them is where the commons lives, and none of them should be. The
 * commons is a folder at the top of this repository, versioned with the code it
 * drives, so that what a machine is running and what admitted it are one history
 * rather than two records that can disagree.
 *
 * So it is mounted as an extension root rather than by moving the folder under a
 * path the runtime already scans. Two reasons, and the second is the one that
 * matters. The first is that `skills/` at the top of the tree is where a person
 * looks for it. The second is that an extension root is composed into the source
 * the runtime *reads* and is never written back through, and the hub's session
 * holds no file-writing tools at all — so a route an agent was handed cannot be
 * quietly amended in place on the machine that received it. A commons the local
 * agent could edit would be a commons whose provenance is a claim rather than a
 * history. The way a skill changes is a proposal somebody merges.
 *
 * What arrives here has already been through the gate on some other machine and
 * past a human reading both halves of the pair. It is still advisory. A route is
 * what worked somewhere else, against a version named in its own frontmatter,
 * and the agent following it verifies each step against the tree in front of it.
 */

/**
 * Identifies the extended workspace in the runtime's resolver cache.
 *
 * The runtime keys cached workspaces by id and appends this to it, so a hub with
 * the commons mounted and one without resolve to different workspaces rather
 * than to whichever happened to be built first.
 */
export const COMMONS_EXTENSION_ID = "skill-commons";

/**
 * The commons, as a root for the runtime to scan, or nothing.
 *
 * Answers `undefined` when there is no folder to mount. That is the ordinary
 * case for an installed product rather than an error in it — the commons is
 * deliberately not in the release, so an end user's hub runs with the skills the
 * runtime already finds and this contributes none. A missing commons is a hub
 * with fewer skills, never a hub that fails to boot.
 *
 * The existence check is here rather than left to the runtime because an
 * extension's roots are handed to the workspace as given: the runtime filters
 * the paths it discovers itself, and a root that does not exist would be
 * scanned for skills on every resolution and quietly find none.
 */
export function commonsSkillExtension(commonsPath?: string): WorkspaceSkillExtension | undefined {
  if (!commonsPath) return undefined;
  const resolved = path.resolve(commonsPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
  return {
    id: COMMONS_EXTENSION_ID,
    paths: [resolved],
    // The workspace's own filesystem, unchanged. The commons sits beside the
    // project the hub already reads, so the source that reads one reads the
    // other, and a second source would be a second set of rules about what may
    // be read — which is one more place for them to disagree.
    createSource: (fallback: SkillSource) => fallback,
  };
}
