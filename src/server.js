// The laptop side: serves the phone app and receives commands. Every request needs the secret
// pairing token, which only your phone has (set up by "npm run setup").
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, getHistory, spentThisMonth } from './config.js';
import { since, subscribe, settle, lastId } from './events.js';
import * as agent from './agent.js';
import { getShared } from './laptop.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
let cfg = loadConfig();
const PRACTICE = !!process.env.JARVIS_MOCK || process.argv.includes('--practice');
const run = PRACTICE ? (await import('./mock.js')).runCommand : agent.runCommand;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authed(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('t');
  return safeEqual(token, cfg.token);
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(s)); } catch { resolve({ text: s }); } // Siri Shortcuts may send plain text
    });
  });
}

function projectList() { return [...Object.keys(cfg.projects), agent.GENERAL]; }

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // The app itself (no secrets in it; the token is entered on the phone).
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }

  // The phone app may be hosted elsewhere (GitHub Pages), so allow cross-origin calls.
  // Safe because every API call still needs the secret pairing token.
  if (p.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (!authed(req, url)) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return send(res, 401, { error: 'Not paired. Scan the setup code again.' });
  }

  if (p === '/api/status') {
    return send(res, 200, {
      name: cfg.name, owner: cfg.owner, host: os.hostname(), platform: process.platform,
      projects: projectList(), defaultProject: cfg.defaultProject || agent.GENERAL,
      job: agent.status(), spent: spentThisMonth(), budget: cfg.budget, lastEvent: lastId(), mock: PRACTICE,
    });
  }
  if (p === '/api/history') return send(res, 200, getHistory());

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = ev => res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    const from = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
    since(from).forEach(write);
    const off = subscribe(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return;
  }

  if (p === '/api/command' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'Say something first.' });
    if (agent.status().busy) return send(res, 409, { error: `Still working on "${agent.status().text.slice(0, 60)}". Tap Stop first.` });
    cfg = loadConfig();
    run(cfg, text, { project: b.project, fresh: !!b.fresh });
    return send(res, 202, { ok: true });
  }

  // For Siri Shortcuts: send the words, get a short spoken answer back.
  if (p === '/api/siri' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 200, "I didn't catch that.", 'text/plain; charset=utf-8');
    cfg = loadConfig();
    const job = run(cfg, text, { project: b.project });
    const quick = await Promise.race([job, new Promise(r => setTimeout(() => r(null), 25000))]);
    const say = quick ? quick.text : "I'm on it. I'll keep going and you can follow along in the app.";
    return send(res, 200, say.length > 600 ? say.slice(0, 600) + '…' : say, 'text/plain; charset=utf-8');
  }

  if (p === '/api/approve' && req.method === 'POST') {
    const b = await readBody(req);
    return send(res, settle(b.id, !!b.allow, b.allow ? '' : 'Aryan said no.') ? 200 : 404, { ok: true });
  }
  if (p === '/api/stop' && req.method === 'POST') return send(res, 200, { ok: agent.stop() });
  if (p === '/api/reset' && req.method === 'POST') {
    const b = await readBody(req);
    agent.resetConversation(b.project || cfg.defaultProject || agent.GENERAL);
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/api/files/')) {
    const f = getShared(p.slice('/api/files/'.length));
    if (!f || !fs.existsSync(f.path)) return send(res, 404, { error: 'That file has expired.' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f.name).toLowerCase()] || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"`, 'Content-Length': f.size });
    return fs.createReadStream(f.path).pipe(res);
  }
  return send(res, 404, { error: 'Unknown' });
}

export function start() {
  const server = http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch { /* ignore */ } }));
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.log(`${cfg.name} is already running (port ${cfg.port} is in use), so there's nothing to do.`);
    else console.error(e);
    process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
  });
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`${cfg.name} is listening on port ${cfg.port}${PRACTICE ? ' (practice mode, no AI)' : ''}.`);
    if (!cfg.apiKey && !process.env.ANTHROPIC_API_KEY && !PRACTICE) console.log('No API key yet: run "npm run setup".');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
