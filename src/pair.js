// Shows how to pair the iPhone: QR code, link, and the laptop address + pairing code as plain lines.
// Run on its own with: npm run pair
import qrcode from 'qrcode-terminal';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { enableTailscaleHttps, tailscaleAddress, lanAddress } from './network.js';

export async function showPairing(cfg, say = s => console.log(s)) {
  const ts = await tailscaleAddress();
  let url, host;
  if (ts.ok) {
    const https = await enableTailscaleHttps(cfg.port);
    if (https.ok) host = https.url.replace(/^https:\/\//, '');
    if (https.ok && cfg.appUrl) url = `${cfg.appUrl}#lh=${host}&t=${cfg.token}`;
    else if (!https.ok) say('⚠ Couldn\'t switch on Tailscale HTTPS. In the Tailscale admin console go to DNS and enable "HTTPS Certificates", then run this again. For now, the laptop link below works in Safari directly.');
  }
  if (!host) host = `${ts.ok ? ts.host : lanAddress()}:${cfg.port}`;
  if (!url) url = `http://${host}/#t=${cfg.token}`;
  say('\n──────────── Pair your iPhone ────────────');
  if (!ts.ok) say('⚠ Tailscale isn\'t running, so this only works on the same Wi-Fi. Install Tailscale (see README) and run setup again for anywhere access.');
  say('Option A: open the iPhone Camera, point it at this code and tap the link (pairs Safari).');
  qrcode.generate(url, { small: true });
  say(`   (or open: ${url})`);
  say(`   Then in Safari tap ⚙︎ Settings > "Copy pairing for the home-screen app", open the home-screen`);
  say(`   ${cfg.name} app, go to ⚙︎ Settings, paste into "Pairing link" and tap Pair.`);
  say('\nOption B: in the app go to ⚙︎ Settings > Laptop mode and type these two lines:');
  say(`   Laptop address:  ${host}`);
  say(`   Pairing code:    ${cfg.token}`);
  say('\nKeep the code private: anyone with it can control the laptop.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  showPairing(loadConfig()).catch(e => { console.error(e?.message || e); process.exit(1); });
}
