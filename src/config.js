// Settings, secrets and small state files live in ~/.jarvis (never inside a project folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.JARVIS_HOME || path.join(os.homedir(), '.jarvis');
const CONFIG = path.join(HOME, 'config.json');

export const DEFAULTS = {
  name: 'Jarvis',
  owner: 'Aryan',
  port: 7777,
  token: '',
  apiKey: '',
  model: '', // empty = SDK default
  projects: {}, // { "Gia Mia": "C:\\Users\\aryan\\code\\gia-foodtracker" }
  defaultProject: '',
  budget: { perJobUsd: 3, monthlyUsd: 20 },
  // How much it may do without asking: 'careful' asks before any shell command that isn't on the safe list.
  trust: 'careful',
  appUrl: '', // where the phone app is hosted (GitHub Pages)
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(HOME, 'outbox'), { recursive: true });
}

export function loadConfig() {
  ensureHome();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* first run */ }
  const cfg = { ...DEFAULTS, ...saved, budget: { ...DEFAULTS.budget, ...(saved.budget || {}) } };
  if (!cfg.token) { cfg.token = newToken(); saveConfig(cfg); }
  return cfg;
}

export function saveConfig(cfg) {
  ensureHome();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG, 0o600); } catch { /* Windows */ }
}

export const newToken = () => crypto.randomBytes(24).toString('base64url');

// ---- small JSON state files ----
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, file), 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  ensureHome();
  fs.writeFileSync(path.join(HOME, file), JSON.stringify(value, null, 2));
}

// Conversation memory: one ongoing session per project, so "now make it pink" follows on.
export const getSessions = () => readJSON('sessions.json', {});
export function setSession(project, id) { const s = getSessions(); s[project] = id; writeJSON('sessions.json', s); }
export function clearSession(project) { const s = getSessions(); delete s[project]; writeJSON('sessions.json', s); }

// Spending, by calendar month.
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export function spentThisMonth() { return readJSON('spend.json', {})[monthKey()] || 0; }
export function addSpend(usd) {
  const s = readJSON('spend.json', {});
  s[monthKey()] = Math.round(((s[monthKey()] || 0) + (usd || 0)) * 10000) / 10000;
  writeJSON('spend.json', s);
}

// Recent history shown in the phone app.
export const getHistory = () => readJSON('history.json', []);
export function pushHistory(item) {
  const h = getHistory();
  h.push(item);
  writeJSON('history.json', h.slice(-60));
}
