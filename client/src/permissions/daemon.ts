import {
  DesktopClient,
  DesktopServiceError,
} from "../../../clients/shared/src/desktop-client.ts";

export { findDaemonSocket } from "../../../clients/shared/src/discover.ts";

/**
 * The one daemon question the permissions page asks: what is running.
 *
 * The hub already reaches the daemon through the desktop plugin for the
 * agent's sake; this lane exists because a page render must not spend an agent
 * turn to draw a checklist. It used to hand-roll the wire format to get that —
 * its own buffer scan, its own timer — which is precisely the duplication
 * `clients/shared` exists to end. What is left here is the part that is
 * actually about permissions: which method to ask, and what a row means.
 *
 * Nothing here can widen anything: the socket has no method that widens, and
 * this client asks one question — `listApplications`, an observe-class method
 * a fresh connection already holds.
 */

export type CensusApplication = { name: string; running: true; readable: boolean };

export type Census =
  | { reachable: true; applications: CensusApplication[] }
  | { reachable: false; reason: string };

const CENSUS_TIMEOUT_MS = 5_000;

type ListApplicationsResult = {
  applications?: { name: string }[];
  invisibleApplications?: { name: string }[];
};

/**
 * Ask the daemon what is running. Unreachable is an answer, not an error:
 * the page renders installed applications either way and says the daemon is
 * not running, because a checklist that 500s when the daemon naps would make
 * the permissions page unusable exactly when the user might want to prepare
 * permissions for the daemon's next start.
 */
export async function readCensus(socketPath: string | undefined): Promise<Census> {
  if (!socketPath) {
    return { reachable: false, reason: "The desktop service is not running (no socket found)." };
  }

  // One request, one connection, closed after the answer.
  const client = new DesktopClient({
    socketPath,
    requestTimeoutMs: CENSUS_TIMEOUT_MS,
    connectTimeoutMs: CENSUS_TIMEOUT_MS,
  });
  try {
    const result = await client.request<ListApplicationsResult>("listApplications");
    return { reachable: true, applications: toCensusRows(result ?? {}) };
  } catch (error) {
    return { reachable: false, reason: unreachableBecause(error) };
  } finally {
    client.close();
  }
}

/**
 * A sentence for the page. The shared client already distinguishes "nothing is
 * listening" from "it did not answer", so this only has to choose the words a
 * reader of a permissions checklist needs.
 */
function unreachableBecause(error: unknown): string {
  if (error instanceof DesktopServiceError) {
    if (error.code === "TIMEOUT") return "The desktop service did not answer in time.";
    if (error.code === "BACKEND_UNAVAILABLE") return "The desktop service is not running.";
    return error.message;
  }
  return "The desktop service answered unreadably.";
}

function toCensusRows(result: ListApplicationsResult): CensusApplication[] {
  return [
    // On the accessibility bus: running and readable.
    ...(result.applications ?? []).map((app) => ({
      name: app.name,
      running: true as const,
      readable: true,
    })),
    // Windows the display server sees but the accessibility layer cannot:
    // running, not readable — the page's "needs a restart to become readable"
    // pill is born from exactly this distinction.
    ...(result.invisibleApplications ?? []).map((app) => ({
      name: app.name,
      running: true as const,
      readable: false,
    })),
  ];
}
