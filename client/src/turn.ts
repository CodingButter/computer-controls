/**
 * Which turn is speaking.
 *
 * A turn is one thing a person said and everything the hub did about it: one
 * message posted to the chat page, one utterance at the orb. Inside a turn the
 * agent may think, delegate to a subagent, and call as many tools as it likes —
 * all of that is still the same turn, because the person has not spoken again.
 *
 * That distinction is the only thing separating a confirmation the person gave
 * from a confirmation the model gave itself. A model holding a handle to a
 * staged change can call the confirm tool immediately, in the same turn, without
 * anyone ever hearing the sentence it was told to read out. Telling it to wait
 * is an instruction. Comparing the turn it is confirming in against the turn the
 * change was staged in is a check, and only the hub can make that comparison,
 * because only the hub knows where one turn ends and the next begins.
 *
 * The identity travels by `AsyncLocalStorage` rather than by argument. The tools
 * that need it are built once at boot, long before any turn exists, and the
 * runtime that calls them hands them their input and its own context — there is
 * no parameter to thread a turn id through. Ambient context is what Node offers
 * for exactly this: a value scoped to the async work of one request, invisible
 * to code that does not ask for it, and impossible for the model to name.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export class TurnScope {
  private readonly storage = new AsyncLocalStorage<string>();

  /**
   * Run `body` as one turn, under an identity minted here.
   *
   * The identity is a random id rather than a counter: nothing may be able to
   * guess the next turn, or a staged change could be confirmed against a turn
   * that has not happened yet.
   */
  run<T>(body: (turn: string) => T): T {
    const turn = randomUUID();
    return this.storage.run(turn, () => body(turn));
  }

  /** The turn in flight, or nothing when the caller is not inside one. */
  current(): string | undefined {
    return this.storage.getStore();
  }
}

/**
 * The hub's turns.
 *
 * One process, one conversation clock. The chat entry point opens a turn on this
 * scope and the settings gate reads it, which is why neither of them has to be
 * handed to the other: they are two ends of the same boundary.
 */
export const HUB_TURNS = new TurnScope();
