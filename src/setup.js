// First-time setup: npm run setup
// Asks a few questions, checks the API key, finds Gia Mia, and shows a QR code to pair your iPhone.
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import qrcode from 'qrcode-terminal';
import { loadConfig, saveConfig, newToken } from './config.js';
import { enableTailscaleHttps, tailscaleAddress, lanAddress } from './network.js';
import { install } from './autostart.js';

const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q, def) => {
  stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
  const { value, done } = await lines.next();
  if (done) throw new Error('Setup was cancelled.');
  if (!stdin.isTTY) stdout.write('\n');
  return (value || '').trim() || def || '';
};
const yes = async (q, def = true) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
const say = s => console.log(s);

async function checkKey(key) {
  if (process.env.JARVIS_SKIP_KEYCHECK) return 'ok'; // used by tests only
  try {
    const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    if (r.ok) return 'ok';
    return r.status === 401 ? 'bad' : `HTTP ${r.status}`;
  } catch { return 'offline'; }
}

function findGiaMia() {
  const h = os.homedir();
  const guesses = ['gia-foodtracker', 'code/gia-foodtracker', 'Documents/gia-foodtracker', 'Desktop/gia-foodtracker', 'Projects/gia-foodtracker', 'source/repos/gia-foodtracker', 'Documents/GitHub/gia-foodtracker'];
  return guesses.map(g => path.join(h, g)).find(p => fs.existsSync(path.join(p, 'package.json'))) || '';
}

async function main() {
  const cfg = loadConfig();
  say('\n✦ Setting up your laptop assistant ✦\n');

  cfg.name = await ask('What should your assistant be called?', cfg.name);
  cfg.owner = await ask('And your name?', cfg.owner);

  // API key
  say('\nIt needs an Anthropic API key (from console.anthropic.com > API Keys).');
  say('Tip: make a separate key just for this, so you can see its spending on its own.');
  for (;;) {
    const current = cfg.apiKey ? `keep current (…${cfg.apiKey.slice(-4)})` : '';
    const k = (await ask('Paste the API key', current)).replace(/\s/g, '');
    if (cfg.apiKey && k === current.replace(/\s/g, '')) break;
    if (!k.startsWith('sk-ant-')) { say('That doesn\'t look like a key (they start with sk-ant-). Try again.'); continue; }
    const r = await checkKey(k);
    if (r === 'ok') { cfg.apiKey = k; say('✓ Key works.'); break; }
    if (r === 'bad') { say('✗ Anthropic rejected that key. Copy it again, or create a new one.'); continue; }
    say(`Couldn't check the key (${r}). Saving it anyway.`); cfg.apiKey = k; break;
  }

  // Projects
  say('\nProjects are folders it can work in. Let\'s add Gia Mia.');
  let gia = cfg.projects['Gia Mia'] || findGiaMia();
  if (!gia) {
    const where = path.join(os.homedir(), 'gia-foodtracker');
    if (await yes(`Gia Mia isn't on this laptop yet. Download it from GitHub into ${where}?`)) {
      try {
        execFileSync('git', ['clone', 'https://github.com/nagarearyan92-code/gia-foodtracker.git', where], { stdio: 'inherit' });
        gia = where;
        say('Installing its packages (a few minutes)…');
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd: where, stdio: 'inherit', shell: process.platform === 'win32' });
      } catch { say('That didn\'t work. Is Git installed? You can add the folder later by running setup again.'); }
    }
  }
  gia = await ask('Gia Mia folder', gia);
  if (gia && fs.existsSync(path.join(gia, 'package.json'))) { cfg.projects['Gia Mia'] = path.resolve(gia); cfg.defaultProject = cfg.defaultProject || 'Gia Mia'; }
  else if (gia) say('No app found in that folder, skipping. Run setup again to add it.');
  while (await yes('Add another project folder?', false)) {
    const name = await ask('Project name (e.g. Website)');
    const dir = await ask('Folder path');
    if (name && fs.existsSync(dir)) cfg.projects[name] = path.resolve(dir); else say('Folder not found, skipped.');
  }

  // Money and trust
  say('\nSpending limits (in US dollars, same as your Anthropic bill).');
  cfg.budget.perJobUsd = Number(await ask('Most it may spend on one task', String(cfg.budget.perJobUsd))) || 3;
  cfg.budget.monthlyUsd = Number(await ask('Most it may spend per month', String(cfg.budget.monthlyUsd))) || 20;
  say('\nSafety: in "careful" mode it asks your phone before running any command that isn\'t an everyday developer one.');
  say('In "relaxed" mode it only asks for risky things (pushing to GitHub, deleting, system changes, shutting down).');
  cfg.trust = (await ask('careful or relaxed?', cfg.trust)).startsWith('r') ? 'relaxed' : 'careful';

  if (await yes('\nMake a new pairing code? (Do this if you think someone else has the old one.)', false)) cfg.token = newToken();
  saveConfig(cfg);

  // Pairing
  say('\nThe phone app lives online (GitHub Pages) so it also works without the laptop.');
  cfg.appUrl = (await ask('Phone app address (from the README, e.g. https://yourname.github.io/jarvis/)', cfg.appUrl || '')).trim();
  if (cfg.appUrl && !cfg.appUrl.endsWith('/')) cfg.appUrl += '/';
  saveConfig(cfg);
  const ts = await tailscaleAddress();
  let url;
  if (ts.ok) {
    const https = await enableTailscaleHttps(cfg.port);
    if (https.ok && cfg.appUrl) url = `${cfg.appUrl}#lh=${https.url.replace(/^https:\/\//, '')}&t=${cfg.token}`;
    else if (!https.ok) say('⚠ Couldn\'t switch on Tailscale HTTPS. In the Tailscale admin console go to DNS and enable "HTTPS Certificates", then run setup again. For now, the laptop link below works in Safari directly.');
  }
  if (!url) url = `http://${ts.ok ? ts.host : lanAddress()}:${cfg.port}/#t=${cfg.token}`;
  say('\n──────────── Pair your iPhone ────────────');
  if (!ts.ok) say('⚠ Tailscale isn\'t running, so this only works on the same Wi-Fi. Install Tailscale (see README) and run setup again for anywhere access.');
  say('1. Open the iPhone Camera and point it at this code, then tap the link.');
  qrcode.generate(url, { small: true });
  say(`   (or open: ${url})`);
  say(`2. In Safari tap Share > Add to Home Screen. Now ${cfg.name} has his own icon.`);
  say('Keep this code private: anyone with it can control the laptop.\n');

  if (await yes(`Start ${cfg.name} automatically whenever the laptop is on?`)) {
    try { say(install()); } catch (e) { say(`Couldn't set that up: ${e.message}. You can start it by hand with "npm start".`); }
  } else {
    say('Okay. Start it with "npm start" when you want it.');
  }
  say(`\nAll set. Say hi to ${cfg.name} from your phone ✦\n`);
  rl.close();
}

main().catch(e => { console.error('\n' + (e?.message || e)); rl.close(); process.exit(1); });
