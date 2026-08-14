import { describe, expect, it } from 'vitest';
import {
  retireSoleLivePm2God,
  type Pm2GodRetirementRuntime,
} from '../src/cli/pm2-god-retirement.js';

interface HarnessOptions {
  scans: number[][];
  identities?: Record<number, Array<string | undefined>>;
  alive?: Record<number, boolean[]>;
  killError?: Error;
}

function harness(opts: HarnessOptions) {
  const calls = { kill: 0, sleeps: 0 };
  let clock = 0;
  const scanQueue = [...opts.scans];
  const identityQueues = new Map<number, Array<string | undefined>>(
    Object.entries(opts.identities ?? {}).map(([pid, q]) => [Number(pid), [...q]]),
  );
  const aliveQueues = new Map<number, boolean[]>(
    Object.entries(opts.alive ?? {}).map(([pid, q]) => [Number(pid), [...q]]),
  );
  const shift = <T>(queue: T[] | undefined, fallback: T): T =>
    queue === undefined || queue.length === 0 ? fallback : queue.length === 1 ? queue[0] : queue.shift()!;
  const rt: Pm2GodRetirementRuntime = {
    listGodPids: () => shift(scanQueue.length > 0 ? scanQueue : undefined, []),
    readStartIdentity: pid => shift(identityQueues.get(pid), undefined),
    isAlive: pid => shift(aliveQueues.get(pid), false),
    pm2Kill: () => {
      calls.kill++;
      if (opts.killError) throw opts.killError;
    },
    sleep: async () => { calls.sleeps++; clock += 1_000; },
    now: () => clock,
  };
  return { rt, calls };
}

describe('retireSoleLivePm2God', () => {
  it('no live God → returns null without touching pm2', async () => {
    const { rt, calls } = harness({ scans: [[]] });
    await expect(retireSoleLivePm2God(rt)).resolves.toBeNull();
    expect(calls.kill).toBe(0);
  });

  it('multiple visible Gods → fails closed before any kill', async () => {
    const { rt, calls } = harness({ scans: [[101, 202]] });
    await expect(retireSoleLivePm2God(rt)).rejects.toThrow(/multiple PM2 God daemons/);
    expect(calls.kill).toBe(0);
  });

  it('invalid or duplicate scan rows → fails closed before any kill', async () => {
    for (const scan of [[0], [-3], [7046, 7046]]) {
      const { rt, calls } = harness({ scans: [scan] });
      await expect(retireSoleLivePm2God(rt)).rejects.toThrow(/invalid\/duplicate PIDs/);
      expect(calls.kill).toBe(0);
    }
  });

  it('sole God → socket kill, then verified gone by scan + pid death', async () => {
    const { rt, calls } = harness({
      scans: [[7046], [7046], []],
      identities: { 7046: ['birth-A'] },
      alive: { 7046: [true, false] },
    });
    await expect(retireSoleLivePm2God(rt)).resolves.toEqual({ pid: 7046, startIdentity: 'birth-A' });
    expect(calls.kill).toBe(1);
  });

  it('pid reused by a different birth counts as gone once the scan is empty', async () => {
    const { rt } = harness({
      scans: [[7046], []],
      identities: { 7046: ['birth-A', 'birth-B'] },
      alive: { 7046: [true] },
    });
    await expect(retireSoleLivePm2God(rt)).resolves.toEqual({ pid: 7046, startIdentity: 'birth-A' });
  });

  it('God still observable at the deadline → fails closed with recovery guidance', async () => {
    const { rt } = harness({
      scans: [[7046], [7046]],
      identities: { 7046: ['birth-A'] },
      alive: { 7046: [true] },
    });
    await expect(retireSoleLivePm2God(rt, 3_000))
      .rejects.toThrow(/still observable after pm2 kill/);
  });

  it('pm2 kill failure propagates', async () => {
    const { rt } = harness({
      scans: [[7046]],
      killError: new Error('pm2 kill failed: status 1'),
    });
    await expect(retireSoleLivePm2God(rt)).rejects.toThrow(/pm2 kill failed/);
  });
});
