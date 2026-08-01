/**
 * The arming processor.
 *
 * It contributes nothing to the model's input — it returns the message list it
 * was handed, untouched. Its whole job is to run on a turn and say "this thread
 * exists" to the push lane, because that is the one thing a tool call cannot be
 * relied upon to do: the turn that matters most for this feature is precisely
 * the turn where the model called no desktop tool at all.
 *
 * Thread identity comes from the memory request context rather than from
 * arguments, because `processInput` is handed the context but not the ids. A
 * turn without memory-backed thread ids simply does not arm; there is nothing
 * to subscribe and nowhere to deliver.
 */
import type { InputProcessor } from "mastracode/plugin";

import { arm, type Armable } from "./arming.ts";

/** The subset of the memory request context this reads. */
interface MemoryContextLike {
  thread?: { id?: string };
  resourceId?: string;
}

interface RequestContextLike {
  get(key: string): unknown;
}

export function threadIdentity(
  requestContext: RequestContextLike | undefined,
): { threadId: string; resourceId: string } | undefined {
  const memory = requestContext?.get("MastraMemory") as MemoryContextLike | undefined;
  const threadId = memory?.thread?.id;
  const resourceId = memory?.resourceId;
  if (typeof threadId !== "string" || typeof resourceId !== "string") return undefined;
  return { threadId, resourceId };
}

export const ARMING_PROCESSOR_ID = "desktop-control:arming";

export function buildArmingProcessor(provider: Armable): InputProcessor {
  return {
    id: ARMING_PROCESSOR_ID,
    async processInput(args) {
      const identity = threadIdentity(args.requestContext as RequestContextLike | undefined);
      // Deliberately awaited rather than fired and forgotten: `arm` never
      // throws and returns immediately unless it is the first turn for this
      // thread, and a floating promise inside somebody's turn is how unhandled
      // rejections get invented later.
      if (identity) await arm(provider, identity.threadId, identity.resourceId);
      return args.messages;
    },
  } as InputProcessor;
}
