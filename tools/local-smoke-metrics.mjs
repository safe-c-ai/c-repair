// Opt-in smoke telemetry. GPU-wide memory is sampled, not a per-model peak.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
const exec = promisify(execFile);
export async function memorySample(port) {
  const sample = { at: new Date().toISOString() };
  try {
    const { stdout } = await exec('nvidia-smi', ['--query-gpu=index,memory.used,memory.free', '--format=csv,noheader,nounits'], { timeout: 2000 });
    sample.gpus = stdout.trim().split('\n').map(line => {
      const [index, usedMiB, freeMiB] = line.split(',').map(Number);
      return { index, usedMiB, freeMiB };
    }).filter(g => Object.values(g).every(Number.isFinite));
  } catch { /* unsupported telemetry remains absent */ }
  try {
    sample.hostAvailableMiB = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1]) / 1024;
    if (port) for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (args[args.indexOf('--port') + 1] !== String(port)) continue;
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        sample.runtime = { pid: Number(pid) };
        for (const key of ['VmRSS', 'RssAnon', 'RssFile']) {
          const value = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
          if (value) sample.runtime[`${key}MiB`] = Number(value[1]) / 1024;
        }
        break;
      } catch { /* process exited */ }
    }
  } catch { /* non-Linux host */ }
  return sample;
}
