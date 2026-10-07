// Works out the address your phone should use: the laptop's Tailscale name/IP if available.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 8000, windowsHide: true }, (e, out) => resolve(e ? '' : String(out).trim())));
}

function tailscaleCmd() {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Tailscale\\tailscale.exe';
    return fs.existsSync(p) ? p : 'tailscale';
  }
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) return '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return 'tailscale';
}

export async function tailscaleAddress() {
  const ts = tailscaleCmd();
  const json = await run(ts, ['status', '--json']);
  if (json) {
    try {
      const s = JSON.parse(json);
      const dns = (s.Self?.DNSName || '').replace(/\.$/, '');
      const ip = (s.Self?.TailscaleIPs || []).find(x => x.includes('.'));
      if (s.BackendState === 'Running' && (dns || ip)) return { host: dns || ip, ip, dns, ok: true };
    } catch { /* fall through */ }
  }
  const ip = (await run(ts, ['ip', '-4'])).split(/\s+/)[0];
  return ip ? { host: ip, ip, ok: true } : { ok: false };
}

export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) return a.address;
  }
  return 'localhost';
}
