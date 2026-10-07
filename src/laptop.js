// Laptop controls the assistant can use, for Windows and Mac (Linux works for most too).
// Commands are run with execFile (no shell) and user text is quoted, so a request can't
// smuggle in extra commands.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './config.js';
import { emit } from './events.js';

const OS = process.platform; // 'win32' | 'darwin' | 'linux'
const psq = s => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
const asq = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

function run(cmd, args, { timeout = 20000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}
const ps = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
const osa = script => run('osascript', ['-e', script]);

const done = (ok, text) => ({ ok, text });

export async function openApp(name) {
  if (OS === 'win32') {
    // Try it as a command/registered app first, then search the Start menu by name.
    let r = await ps(`Start-Process ${psq(name)}`);
    if (r.ok) return done(true, `Opened ${name}.`);
    r = await ps(`$a = Get-StartApps | Where-Object { $_.Name -like ${psq('*' + name + '*')} } | Select-Object -First 1; if ($a) { Start-Process ('shell:AppsFolder\\' + $a.AppID); $a.Name } else { exit 1 }`);
    return r.ok ? done(true, `Opened ${r.out || name}.`) : done(false, `Couldn't find an app called "${name}".`);
  }
  if (OS === 'darwin') {
    const r = await run('open', ['-a', name]);
    return r.ok ? done(true, `Opened ${name}.`) : done(false, `Couldn't find an app called "${name}".`);
  }
  const r = await run('gtk-launch', [name]);
  return r.ok ? done(true, `Opened ${name}.`) : done(false, `Couldn't open "${name}" on this system.`);
}

export async function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) return done(false, 'Only http(s) links can be opened.');
  const r = OS === 'win32' ? await ps(`Start-Process ${psq(url)}`)
    : await run(OS === 'darwin' ? 'open' : 'xdg-open', [url]);
  return r.ok ? done(true, `Opened ${url}.`) : done(false, r.err || 'Could not open the link.');
}

export async function lock() {
  const r = OS === 'win32' ? await run('rundll32.exe', ['user32.dll,LockWorkStation'])
    : OS === 'darwin' ? await run('pmset', ['displaysleepnow'])
      : await run('loginctl', ['lock-session']);
  return r.ok ? done(true, 'Laptop locked.') : done(false, r.err);
}

export async function sleepNow() {
  // Reply first, then sleep a moment later so the phone gets the answer.
  setTimeout(() => {
    if (OS === 'win32') run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    else if (OS === 'darwin') run('pmset', ['sleepnow']);
    else run('systemctl', ['suspend']);
  }, 3000);
  return done(true, 'Going to sleep in 3 seconds. I can\'t take commands while it sleeps.');
}

export async function power(action) {
  const delay = 30;
  let r;
  if (action === 'cancel') {
    r = OS === 'win32' ? await run('shutdown', ['/a']) : await run('sudo', ['-n', 'shutdown', '-c']);
    return r.ok ? done(true, 'Cancelled.') : done(false, r.err || 'Nothing to cancel.');
  }
  if (OS === 'win32') r = await run('shutdown', [action === 'restart' ? '/r' : '/s', '/t', String(delay)]);
  else if (OS === 'darwin') r = await osa(`tell application "System Events" to ${action === 'restart' ? 'restart' : 'shut down'}`);
  else r = await run('systemctl', [action === 'restart' ? 'reboot' : 'poweroff']);
  if (!r.ok) return done(false, r.err || 'That didn\'t work.');
  const what = action === 'restart' ? 'Restarting' : 'Shutting down';
  const when = OS === 'win32' ? ` in ${delay} seconds (say "cancel shutdown" to stop it)` : '';
  const back = action === 'restart' ? " until it's back on and you've signed in" : ' until you turn it back on';
  return done(true, `${what}${when}. I'll be offline${back}.`);
}

export async function setVolume(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  if (OS === 'darwin') { const r = await osa(`set volume output volume ${p}`); return r.ok ? done(true, `Volume ${p}%.`) : done(false, r.err); }
  if (OS === 'win32') {
    // No built-in command for this, so press the volume keys: all the way down, then up (each step is 2%).
    const r = await ps(`$w = New-Object -ComObject WScript.Shell; 1..50 | % { $w.SendKeys([char]174) }; 1..${Math.round(p / 2)} | % { $w.SendKeys([char]175) }`);
    return r.ok ? done(true, `Volume about ${p}%.`) : done(false, r.err);
  }
  const r = await run('amixer', ['-q', 'sset', 'Master', `${p}%`]);
  return r.ok ? done(true, `Volume ${p}%.`) : done(false, r.err);
}

export async function screenshot() {
  const file = path.join(HOME, 'outbox', `screen-${Date.now()}.png`);
  let r;
  if (OS === 'win32') {
    r = await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $i = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size); $i.Save(${psq(file)}); $g.Dispose(); $i.Dispose()`);
  } else if (OS === 'darwin') {
    r = await run('screencapture', ['-x', file]);
  } else {
    r = await run('import', ['-window', 'root', file]);
  }
  if (!fs.existsSync(file)) return done(false, OS === 'darwin'
    ? 'Screenshot failed. On a Mac, allow Screen Recording for Terminal/Node in System Settings > Privacy & Security.'
    : `Screenshot failed${r.err ? ': ' + r.err : ''}. If the laptop is locked, there's nothing to capture.`);
  const f = shareFile(file, 'Screenshot.png');
  return done(true, `Screenshot sent to your phone (${f.name}).`);
}

export async function systemInfo() {
  const lines = [`${os.hostname()} · ${OS === 'win32' ? 'Windows' : OS === 'darwin' ? 'macOS' : 'Linux'} · up ${Math.round(os.uptime() / 3600)} h`,
    `Memory: ${Math.round((os.totalmem() - os.freemem()) / 1e9 * 10) / 10} of ${Math.round(os.totalmem() / 1e9)} GB in use`];
  if (OS === 'win32') {
    const b = await ps('$b = Get-CimInstance Win32_Battery; if ($b) { "$($b.EstimatedChargeRemaining)% " + $(if ($b.BatteryStatus -eq 2) { "charging" } else { "on battery" }) }');
    if (b.out) lines.push(`Battery: ${b.out}`);
    const d = await ps('Get-PSDrive -PSProvider FileSystem | ? { $_.Used } | % { "$($_.Name): $([math]::Round($_.Free/1GB)) GB free of $([math]::Round(($_.Used+$_.Free)/1GB)) GB" }');
    if (d.out) lines.push(`Storage: ${d.out.split(/\r?\n/).join(', ')}`);
  } else {
    if (OS === 'darwin') { const b = await run('pmset', ['-g', 'batt']); const m = b.out.match(/(\d+%;[^;]+)/); if (m) lines.push(`Battery: ${m[1]}`); }
    const d = await run('df', ['-h', OS === 'darwin' ? '/System/Volumes/Data' : '/']);
    const row = d.out.split('\n')[1]?.split(/\s+/);
    if (row) lines.push(`Storage: ${row[3]} free of ${row[1]}`);
  }
  return done(true, lines.join('\n'));
}

// Files the phone can download: copied into ~/.jarvis/outbox under a random id.
const shared = new Map();
export function shareFile(src, displayName) {
  const id = crypto.randomBytes(9).toString('base64url');
  const name = displayName || path.basename(src);
  const dest = path.join(HOME, 'outbox', `${id}-${name.replace(/[^\w.\- ]/g, '_')}`);
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  const size = fs.statSync(dest).size;
  shared.set(id, { path: dest, name, size });
  emit('file', { fileId: id, name, size });
  return { id, name, size };
}
export const getShared = id => shared.get(id);

export async function sendFile(filePath) {
  const p = path.resolve(filePath.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return done(false, `No file at ${p}.`);
  if (fs.statSync(p).size > 200e6) return done(false, 'That file is over 200 MB, too big to send.');
  const f = shareFile(p);
  return done(true, `Sent ${f.name} to your phone.`);
}

export const PLATFORM = OS;
