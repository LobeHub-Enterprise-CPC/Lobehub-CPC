import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';

/** PID alone is not an incarnation: Linux may reuse it after a crash. */
export const readProcessIdentity = (pid = process.pid) => {
  try {
    const machineId = readFileSync('/etc/machine-id', 'utf8').trim();
    if (!/^[a-f0-9]{32}$/i.test(machineId)) throw new Error('INVALID_MACHINE_ID');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      hostId: createHash('sha256').update(machineId).digest('hex'),
      pidNs: readlinkSync(`/proc/${pid}/ns/pid`),
      pidStartTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    };
  } catch {
    // Unsupported hosts can run, but cannot use the local retirement verifier.
    return { bootId: null, hostId: null, pidNs: null, pidStartTicks: null };
  }
};

export const verifyTerminatedProcess = (
  record: ReturnType<typeof readProcessIdentity> & { pid: number },
) => {
  const local = readProcessIdentity();
  if (!local.hostId || !record.hostId || local.hostId !== record.hostId)
    throw new Error('RETIRE_HOST_NOT_VERIFIED');
  if (!record.bootId || !record.pidNs || !record.pidStartTicks)
    throw new Error('RETIRE_INCARNATION_NOT_VERIFIED');
  if (record.bootId !== local.bootId) throw new Error('RETIRE_BOOT_NOT_VERIFIED');
  if (record.pidNs !== local.pidNs) throw new Error('RETIRE_PID_NAMESPACE_NOT_VERIFIED');
  const current = readProcessIdentity(record.pid);
  if (current.pidStartTicks && current.pidStartTicks !== record.pidStartTicks)
    return { kind: 'pid-reused', checkedAt: new Date().toISOString(), hostId: local.hostId };
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH')
      return { kind: 'process-exited', checkedAt: new Date().toISOString(), hostId: local.hostId };
    throw new Error('RETIRE_PROCESS_NOT_VERIFIED', { cause: error });
  }
  throw new Error('RETIRE_PROCESS_STILL_ALIVE');
};
