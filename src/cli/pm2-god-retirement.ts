/**
 * `restart --include-pm2` God retirement.
 *
 * A PID-addressed kill(2) cannot bind a signal to a PID+birth generation, so
 * this module never signals the God by PID. The kill is addressed to the
 * PM2_HOME control socket (`pm2 kill`) — i.e. to
 * "whichever God owns this home", which is exactly the object being retired —
 * and the recorded pid+birth identity is used only to VERIFY disappearance
 * afterwards. Callers must run this strictly AFTER the managed core fleet has
 * been retired and verified gone (and plugin services stopped): with an empty
 * fleet the God holds no session state, so retiring it cannot interrupt a
 * Riff prepare/persist/commit handshake.
 */

export interface Pm2GodRetirementRuntime {
  /** Scan for God processes owning this PM2_HOME (cmdline-marker based). */
  listGodPids(): number[];
  /** Birth identity for verification only — never signalling authority. */
  readStartIdentity(pid: number): string | undefined;
  isAlive(pid: number): boolean;
  /** Bounded `pm2 kill` against this PM2_HOME's control socket. */
  pm2Kill(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const PM2_GOD_RETIREMENT_VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_INTERVAL_MS = 200;

export interface RetiredPm2God {
  pid: number;
  startIdentity: string | undefined;
}

/**
 * Retire the sole live PM2 God, or return null when none is alive. Fails
 * closed — without mutating anything — on an invalid scan or multiple visible
 * Gods, and fails closed after `pm2 kill` if the God's disappearance cannot
 * be proven within the timeout.
 */
export async function retireSoleLivePm2God(
  rt: Pm2GodRetirementRuntime,
  timeoutMs: number = PM2_GOD_RETIREMENT_VERIFY_TIMEOUT_MS,
): Promise<RetiredPm2God | null> {
  const scanned = rt.listGodPids();
  const canonical = [...new Set(scanned)]
    .filter(pid => Number.isSafeInteger(pid) && pid > 1)
    .sort((a, b) => a - b);
  if (canonical.length !== scanned.length) {
    throw new Error('[restart --include-pm2] PM2 God scan returned invalid/duplicate PIDs; no process was signalled');
  }
  if (canonical.length === 0) return null;
  if (canonical.length > 1) {
    throw new Error(
      `[restart --include-pm2] multiple PM2 God daemons are visible `
      + `(pids: ${canonical.join(', ')}); no process was signalled`,
    );
  }

  const pid = canonical[0];
  const startIdentity = rt.readStartIdentity(pid);
  rt.pm2Kill();

  const deadline = rt.now() + timeoutMs;
  for (;;) {
    // Two independent proofs: the marker scan finds no God for this home, and
    // the original pid is gone (or its slot was reused by a different birth).
    const scanEmpty = rt.listGodPids().length === 0;
    const originalGone = !rt.isAlive(pid)
      || (startIdentity !== undefined && rt.readStartIdentity(pid) !== startIdentity);
    if (scanEmpty && originalGone) return { pid, startIdentity };
    if (rt.now() >= deadline) {
      throw new Error(
        `[restart --include-pm2] PM2 God pid ${pid} is still observable after pm2 kill; `
        + 'the core fleet is already retired and nothing further was mutated — '
        + 'inspect the God process, then rerun `botmux restart` (with or without --include-pm2) to bring the fleet back',
      );
    }
    await rt.sleep(VERIFY_POLL_INTERVAL_MS);
  }
}
