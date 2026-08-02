/**
 * How the push lane learns a thread exists.
 *
 * A signal provider with zero subscriptions polls nothing and is silent
 * forever, so something has to name the current thread to it. The obvious
 * place is a tool call — that is how the reference plugin does it — and for
 * this lane it is not enough on its own.
 *
 * The proof this phase exists for is a desktop change reaching the model on a
 * turn where no desktop tool was called. If subscription only ever happened
 * from tool-call context, that turn is exactly the one where the provider was
 * never armed, and the proof would fail for a reason that has nothing to do
 * with the delta lane working.
 *
 * So arming happens from the input-processor path, which runs on every turn
 * regardless of what the model decides to call, and has the thread and
 * resource ids in hand.
 *
 * That path is the only one, deliberately. A second trigger from tool-call
 * context would be redundant on any host that harvests plugin processors, and
 * on a host that does not, the lane should be visibly dead rather than
 * intermittently alive — a push lane that works only after you happen to call
 * a tool is worse than one that plainly does not work, because nobody
 * investigates the second kind.
 */
import type { InputProcessor } from "mastracode/plugin";

/** The narrow slice of the provider this module drives. */
export interface Armable {
  subscribeThread(threadId: string, resourceId: string): boolean;
  kickPoll(): Promise<void>;
}

/**
 * Subscribe a thread and, if that was new, poll immediately.
 *
 * The kick matters because the base class's timer has no leading tick: a
 * thread that arrives just after one fired would otherwise wait a full
 * interval before the desktop could reach it. Kicking only on a *new*
 * subscription keeps a busy turn from kicking once per tool call.
 *
 * Never throws. This runs inside somebody else's turn, and a desktop service
 * that is down, restarting, or absent must cost that turn nothing.
 */
export async function arm(provider: Armable, threadId: string, resourceId: string): Promise<void> {
  try {
    if (!provider.subscribeThread(threadId, resourceId)) return;
    await provider.kickPoll();
  } catch {
    // Fail-soft: the lane going quiet is a degraded feature; throwing here
    // would be a broken session.
  }
}
