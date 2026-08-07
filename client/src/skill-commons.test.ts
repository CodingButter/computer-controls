import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, expect, test } from "vitest";

import { resolveClientConfig } from "./config.ts";
import { COMMONS_EXTENSION_ID, commonsSkillExtension } from "./skill-commons.ts";
import { hubWorkspace } from "./toolbox.ts";

/**
 * The far end of the whole feature: a skill one machine derived, admitted by a
 * person, is a skill this machine's agent can be handed.
 *
 * Everything before this file happens on the machine that *published*. This is
 * the machine that received, and the only question it answers is whether the
 * merged folder is actually reachable from a session — because a commons that
 * is committed, reviewed and merged, and then not found by the runtime, is a
 * folder of Markdown nobody reads.
 *
 * The workspace here is resolved the way the hub resolves it, through the same
 * function `prepareHub` is handed, rather than by constructing one that happens
 * to have the right paths on it.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "comcon-commons-"));
const commons = path.join(root, "skills");

/** The seed skill in this repository, which is what a real one looks like. */
const REPO_COMMONS = path.resolve(import.meta.dirname, "..", "..", "skills");
const SEED = "discord-read-latest-direct-message";

/** A skill of the same shape, arrived by fetch rather than by checkout. */
const FETCHED = "firefox-open-a-new-tab";

async function workspaceOn(commonsPath?: string): Promise<AnyWorkspace> {
  const requestContext = new RequestContext();
  requestContext.set("controller", {
    getState: () => ({ projectPath: root, configDir: ".mastracode", homeDir: root }),
  } as never);
  const resolve = hubWorkspace({ commonsPath });
  return (await resolve({ requestContext })) as AnyWorkspace;
}

beforeAll(() => {
  fs.mkdirSync(path.join(commons, SEED), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_COMMONS, SEED, "SKILL.md"),
    path.join(commons, SEED, "SKILL.md"),
  );

  // A second skill in the same folder, of the other provenance: one this
  // machine fetched rather than derived, marker and all.
  fs.mkdirSync(path.join(commons, FETCHED), { recursive: true });
  fs.writeFileSync(
    path.join(commons, FETCHED, "SKILL.md"),
    fs
      .readFileSync(path.join(REPO_COMMONS, SEED, "SKILL.md"), "utf8")
      .replace(`name: "${SEED}"`, `name: "${FETCHED}"`),
  );
  fs.writeFileSync(
    path.join(commons, FETCHED, "FETCHED.json"),
    JSON.stringify({ version: 1, skill: FETCHED, source: "owner/repo@main" }),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("test_a_merged_skill_is_one_this_machines_session_can_be_handed", async () => {
  const workspace = await workspaceOn(commons);
  expect(workspace.skills).toBeDefined();

  const listed = await workspace.skills!.list();
  const names = listed.map((skill) => skill.name);
  expect(names).toContain(SEED);

  // Found is not the same as readable. What the agent is handed is the body,
  // and the body is the route.
  const skill = await workspace.skills!.get(SEED);
  expect(skill).toBeDefined();
  expect(skill!.instructions).toContain("Private channels");
  expect(skill!.description).toContain("discord");
});

test("test_the_route_arrives_carrying_what_it_was_verified_against", async () => {
  // The staleness signal is the reason a consuming agent can weight one route
  // above another, and it is worth nothing if it does not survive the trip.
  const workspace = await workspaceOn(commons);
  const skill = await workspace.skills!.get(SEED);

  const metadata = skill!.metadata as Record<string, unknown>;
  expect(metadata["app-version-verified"]).toBe("1.0.151");
  expect(metadata["last-verified"]).toBe("2026-08-05");
  expect(metadata["verified-count"]).toBe(3);
});

test("test_the_skill_says_it_is_advisory_to_the_agent_that_reads_it", async () => {
  // Not a property of this module — a property of every skill the commons
  // publishes, asserted where an agent would actually encounter it.
  const workspace = await workspaceOn(commons);
  const skill = await workspace.skills!.get(SEED);

  expect(skill!.instructions).toContain("advisory");
  expect(skill!.instructions).toContain("amend");
});

test("test_a_fetched_skill_is_handed_over_like_any_other", async () => {
  // A skill somebody fetched from the commons carries a third file beside the
  // pair, marking where it came from so it can be taken back off the machine.
  // That file is the fetching side's business and none of the runtime's: the
  // route has to arrive exactly as a merged one does, with no more standing and
  // no less, and the marker must not turn up as a skill of its own.
  const workspace = await workspaceOn(commons);
  const names = (await workspace.skills!.list()).map((skill) => skill.name);

  expect(names).toContain(FETCHED);
  expect(names).not.toContain("FETCHED.json");

  const skill = await workspace.skills!.get(FETCHED);
  expect(skill!.instructions).toContain("advisory");
});

test("test_a_hub_with_no_commons_boots_with_fewer_skills_and_not_no_hub", async () => {
  // The ordinary case for an installed product: the folder is not in the
  // release. A missing commons must cost the agent routes, never the session.
  expect(commonsSkillExtension(path.join(root, "not-here"))).toBeUndefined();
  expect(commonsSkillExtension(undefined)).toBeUndefined();

  const workspace = await workspaceOn(path.join(root, "not-here"));
  expect(workspace.skills).toBeDefined();
  expect((await workspace.skills!.list()).map((skill) => skill.name)).not.toContain(SEED);
});

test("test_a_file_where_the_commons_should_be_is_not_a_commons", () => {
  const decoy = path.join(root, "skills.md");
  fs.writeFileSync(decoy, "# not a directory\n");
  expect(commonsSkillExtension(decoy)).toBeUndefined();
});

test("test_the_commons_and_the_bare_hub_are_not_the_same_cached_workspace", async () => {
  // The runtime caches workspaces by id. Without a distinct id, whichever hub
  // resolved first would answer for both, and a session would hold whatever
  // skills the previous one mounted.
  expect(commonsSkillExtension(commons)!.id).toBe(COMMONS_EXTENSION_ID);

  const withCommons = await workspaceOn(commons);
  const without = await workspaceOn(undefined);
  expect(withCommons.id).not.toBe(without.id);
});

test("test_the_hub_reads_the_commons_this_repository_ships", () => {
  // The path the hub resolves by default is the folder that is actually in the
  // tree — not a plausible one that would silently find nothing.
  const config = resolveClientConfig({ COMCON_CLIENT_ROOT: root } as NodeJS.ProcessEnv);
  expect(config.commonsPath).toBe(REPO_COMMONS);
  expect(fs.existsSync(path.join(config.commonsPath!, SEED, "SKILL.md"))).toBe(true);
});
