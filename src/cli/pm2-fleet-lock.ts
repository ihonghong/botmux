import { join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';

/**
 * One lock for every botmux-internal mutation of the shared PM2_HOME
 * (~/.botmux/pm2): core fleet stop/start/restart AND plugin service
 * lifecycle. Core and plugin apps live under the same God, so two separate
 * locks would let a concurrent plugin start slip between an include-pm2
 * restart's plugin stop and its `pm2 kill`, or between the kill and the fresh
 * fleet start. Computed lazily so tests can repoint HOME.
 */
export function pm2FleetMutationLockTarget(): string {
  return join(homedir(), '.botmux', 'pm2-fleet-mutation');
}

let heldDepth = 0;

/** True while this process holds the fleet mutation lock. */
export function pm2FleetMutationLockHeld(): boolean {
  return heldDepth > 0;
}

/**
 * Serialize a PM2_HOME mutation against every other botmux process. Re-entrant
 * within one sequential flow (cmdRestart already holds the lock when it stops
 * plugin services through service-manager). The depth counter models NESTING
 * inside one awaited call chain, not parallelism — a process running
 * independent concurrent flows must not rely on it, and daemon/dashboard
 * callers always go through the file lock. Lock order is fixed: fleet lock
 * FIRST, then the plugin service lock — never the reverse.
 */
export async function withPm2FleetMutationLock<T>(
  fn: () => Promise<T> | T,
  opts: { maxWaitMs?: number } = {},
): Promise<T> {
  if (heldDepth > 0) {
    heldDepth++;
    try { return await fn(); } finally { heldDepth--; }
  }
  return withFileLock(pm2FleetMutationLockTarget(), async () => {
    heldDepth++;
    try { return await fn(); } finally { heldDepth--; }
  }, opts);
}

/** Sync variant for sync call sites (plugin service lock wrapper). */
export function withPm2FleetMutationLockSync<T>(
  fn: () => T,
  opts: { maxWaitMs?: number } = {},
): T {
  if (heldDepth > 0) {
    heldDepth++;
    try { return fn(); } finally { heldDepth--; }
  }
  return withFileLockSync(pm2FleetMutationLockTarget(), () => {
    heldDepth++;
    try { return fn(); } finally { heldDepth--; }
  }, opts);
}
