// Makes the assistant start by itself when you sign in to the laptop (Windows and Mac).
//   npm run autostart          -> turn on and start now
//   npm run autostart -- off   -> turn off
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, ensureHome } from './config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, 'src', 'server.js');
const LOG = path.join(HOME, 'server.log');
const NODE = process.execPath;

function winStartupFile() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Jarvis.vbs');
}
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.jarvis.assistant.plist');
const LINUX_UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', 'jarvis.service');

export function install() {
  ensureHome();
  if (process.platform === 'win32') {
    // A tiny script in the Startup folder that runs the server hidden (no window), logging to ~/.jarvis/server.log.
    const cmd = `cmd /c ""${NODE}" "${SERVER}" >> "${LOG}" 2>&1"`;
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${ROOT}"\r\nsh.Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
    fs.writeFileSync(winStartupFile(), vbs);
    spawn('wscript.exe', [winStartupFile()], { detached: true, stdio: 'ignore' }).unref();
    return `Starts automatically when you sign in to Windows (${winStartupFile()}).`;
  }
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.writeFileSync(MAC_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jarvis.assistant</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(path.dirname(NODE))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict></plist>
`);
    try { execFileSync('launchctl', ['unload', MAC_PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['load', '-w', MAC_PLIST]);
    return 'Starts automatically when you log in to your Mac, and restarts itself if it ever stops.';
  }
  fs.mkdirSync(path.dirname(LINUX_UNIT), { recursive: true });
  fs.writeFileSync(LINUX_UNIT, `[Unit]\nDescription=Jarvis assistant\n\n[Service]\nWorkingDirectory=${ROOT}\nExecStart=${NODE} ${SERVER}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'jarvis.service']);
  return 'Starts automatically when you log in.';
}

export function uninstall() {
  if (process.platform === 'win32') { try { fs.unlinkSync(winStartupFile()); } catch { /* none */ } return 'Won\'t start automatically any more. (If it\'s running now, restart the laptop or end "node" in Task Manager.)'; }
  if (process.platform === 'darwin') { try { execFileSync('launchctl', ['unload', '-w', MAC_PLIST]); } catch { /* none */ } try { fs.unlinkSync(MAC_PLIST); } catch { /* none */ } return 'Stopped, and won\'t start automatically any more.'; }
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'jarvis.service']); } catch { /* none */ }
  return 'Stopped, and won\'t start automatically any more.';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(process.argv[2] === 'off' ? uninstall() : install());
}
