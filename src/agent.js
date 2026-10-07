// The brain: each command runs through the Claude Agent SDK (the same agent engine as Claude Code),
// with laptop controls added as tools and a permission policy that asks the phone before anything risky.
import os from 'node:os';
import path from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { addSpend, clearSession, getSessions, pushHistory, setSession, spentThisMonth } from './config.js';
import { emit, requestApproval, denyAllPending } from './events.js';
import * as laptop from './laptop.js';

export const GENERAL = 'General';
let current = null; // { id, text, project, abort, startedAt }

// ---------- laptop tools ----------
const asText = r => ({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
function laptopServer() {
  return createSdkMcpServer({
    name: 'laptop',
    version: '1.0.0',
    tools: [
      tool('open_app', 'Open an app on the laptop by name, e.g. "Spotify", "Visual Studio Code", "Notepad".', { name: z.string() }, async a => asText(await laptop.openApp(a.name))),
      tool('open_url', 'Open a web link in the laptop\'s default browser.', { url: z.string() }, async a => asText(await laptop.openUrl(a.url))),
      tool('lock', 'Lock the laptop screen.', {}, async () => asText(await laptop.lock())),
      tool('sleep', 'Put the laptop to sleep. You stop being reachable until it wakes.', {}, async () => asText(await laptop.sleepNow())),
      tool('power', 'Shut down or restart the laptop, or cancel a pending shutdown (Windows).', { action: z.enum(['shutdown', 'restart', 'cancel']) }, async a => asText(await laptop.power(a.action))),
      tool('set_volume', 'Set the laptop speaker volume, 0-100.', { percent: z.number() }, async a => asText(await laptop.setVolume(a.percent))),
      tool('screenshot', 'Take a screenshot of the laptop screen and send it to the owner\'s phone.', {}, async () => asText(await laptop.screenshot())),
      tool('send_file_to_phone', 'Send a file from the laptop to the owner\'s phone so he can open or save it.', { path: z.string() }, async a => asText(await laptop.sendFile(a.path))),
      tool('system_info', 'Battery, storage, memory and uptime of the laptop.', {}, async () => asText(await laptop.systemInfo())),
    ],
  });
}

// ---------- permission policy ----------
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'NotebookRead', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SAFE_LAPTOP = new Set(['open_app', 'open_url', 'lock', 'set_volume', 'screenshot', 'send_file_to_phone', 'system_info', 'sleep']);

// Commands that always need a yes from the phone, whatever else is in the line.
const RISKY = [
  [/\bgit\s+push\b/i, 'Push to GitHub'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s|rebase|filter-|branch\s+-D|push\s+.*--force)/i, 'Rewrite or discard Git work'],
  [/\b(rm|rmdir|del|erase|rd|Remove-Item|unlink|shred)\b/i, 'Delete files'],
  [/\b(shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer|format|diskpart|mkfs|reg\s+(add|delete)|Set-ItemProperty|bcdedit)\b/i, 'Change system settings'],
  [/\b(sudo|runas|Start-Process\b.*-Verb\s+RunAs)\b/i, 'Run as administrator'],
  [/\b(npm|yarn|pnpm)\s+publish\b|\beas\s+(submit|update)\b/i, 'Publish something'],
  [/(curl|wget|iwr|Invoke-WebRequest)[^|]*\|\s*(sh|bash|iex|Invoke-Expression)/i, 'Run a downloaded script'],
];
// Everyday developer commands that are fine to run without asking.
const SAFE_START = /^(npm\s+(install|i|ci|run|test|ls|outdated|view)|npx\s+(expo|tsc|eslint|prettier|jest)|bunx?\s|node\s|git\s+(status|diff|log|show|add|commit|branch|checkout\s+-b|switch|fetch|pull|stash|remote\s+-v|rev-parse|ls-files)|gh\s+(run|release|pr)\s+(list|view|watch)|ls|dir|pwd|cd|cat|type|echo|head|tail|wc|grep|rg|find|which|where|mkdir|touch|sort|uniq|date|Get-ChildItem|Get-Content|Select-String|Test-Path)\b/i;

function inside(dir, file) {
  if (!dir || !file) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(dir, String(file)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function classifyBash(cmd, trust) {
  for (const [re, why] of RISKY) if (re.test(cmd)) return { ask: true, why };
  const parts = String(cmd).split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean);
  if (parts.every(p => SAFE_START.test(p))) return { ask: false };
  return trust === 'relaxed' ? { ask: false } : { ask: true, why: 'Run a command' };
}

export function makePolicy(projectDir, cfg) {
  return async (toolName, input, { signal }) => {
    const allow = { behavior: 'allow', updatedInput: input };
    if (READ_ONLY.has(toolName)) return allow;
    let title, detail, risk = 'medium';
    if (EDIT_TOOLS.has(toolName)) {
      const file = input.file_path || input.notebook_path;
      if (inside(projectDir, file)) return allow;
      title = 'Change a file outside the project'; detail = String(file); risk = 'high';
    } else if (toolName === 'Bash' || toolName === 'PowerShell') {
      const cmd = String(input.command || '');
      const c = classifyBash(cmd, cfg.trust);
      if (!c.ask) return allow;
      title = c.why; detail = (input.description ? input.description + '\n' : '') + cmd;
      risk = c.why === 'Run a command' ? 'medium' : 'high';
    } else if (toolName.startsWith('mcp__laptop__')) {
      const name = toolName.slice('mcp__laptop__'.length);
      if (SAFE_LAPTOP.has(name)) return allow;
      if (name === 'power' && input.action === 'cancel') return allow;
      title = input.action === 'restart' ? 'Restart the laptop' : 'Shut down the laptop'; detail = 'You won\'t be able to reach me until it\'s back on.'; risk = 'high';
    } else {
      title = `Use ${toolName}`; detail = JSON.stringify(input).slice(0, 400);
    }
    if (signal?.aborted) return { behavior: 'deny', message: 'Stopped.', interrupt: true };
    const answer = await requestApproval({ title, detail, risk });
    return answer.allow ? allow : { behavior: 'deny', message: answer.note || `${cfg.owner} said no. Don't retry this; ask what he'd like instead.` };
  };
}

// ---------- describing progress for the phone ----------
function describeStep(name, input = {}) {
  const base = p => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'Glob': case 'Grep': return 'Searching the code';
    case 'Bash': case 'PowerShell': return input.description || `Running: ${String(input.command || '').slice(0, 80)}`;
    case 'WebSearch': return `Searching the web: ${input.query || ''}`;
    case 'WebFetch': return 'Reading a web page';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'Planning';
    default:
      if (name.startsWith('mcp__laptop__')) return name.slice(13).replace(/_/g, ' ');
      return name;
  }
}

function systemPrompt(cfg, project, cwd) {
  return `You are ${cfg.name}, ${cfg.owner}'s personal assistant, running on his laptop (${laptop.PLATFORM === 'win32' ? 'Windows' : laptop.PLATFORM === 'darwin' ? 'macOS' : 'Linux'}).
${cfg.owner} talks to you from his iPhone, often by voice, and cannot see the laptop screen.
- Keep messages short and friendly. Finish every task with a 1-3 sentence plain-English summary he can read on his phone (it may be read aloud), without code blocks.
- Voice transcription can be wrong. If a request is unclear, or sounds destructive and wasn't clearly meant, ask a short question instead of guessing.
- Use the laptop tools (open_app, open_url, screenshot, set_volume, lock, sleep, power, send_file_to_phone, system_info) for laptop tasks. To show him something, send it with send_file_to_phone or take a screenshot.
- Never print, store or send API keys, passwords or other secrets.
- Risky actions (pushing to GitHub, deleting, system changes) are checked with him on his phone automatically; if he says no, don't try another way round it.
Current project: ${project === GENERAL ? 'none (general laptop tasks); working folder ' + cwd : `${project} at ${cwd}`}.${/gia/i.test(project) ? `
About Gia Mia: an Expo (React Native) Android app ${cfg.owner} made for his partner Gia. Follow the project's AGENTS.md. Check your work (lint/typecheck where available, and \`npx expo export --platform android\` to make sure it bundles). Shipping = commit with a clear message and push to main: GitHub Actions builds the APK and Gia gets an Update button in the app. Before shipping, update WHATS_NEW.md with a short, warm note for Gia about what's new (shown in her app), and tell ${cfg.owner} what will ship. Never break her saved data: keep storage keys compatible.` : ''}`;
}

// Make sure the agent bills the API key from setup, not some other Claude login on the laptop.
function agentEnv(cfg) {
  const env = { ...process.env };
  if (cfg.apiKey) {
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
    env.ANTHROPIC_API_KEY = cfg.apiKey;
  }
  return env;
}

// ---------- running a command ----------
export const status = () => (current ? { busy: true, id: current.id, text: current.text, project: current.project, startedAt: current.startedAt } : { busy: false });

export function stop() {
  if (!current) return false;
  current.abort.abort();
  denyAllPending('Stopped');
  emit('stopping', { jobId: current.id });
  return true;
}

export function resetConversation(project) { clearSession(project); emit('reset', { project }); }

let jobSeq = 0;
// Returns a promise that resolves with { ok, text } when the job finishes.
export async function runCommand(cfg, text, { project, fresh = false } = {}) {
  const refuse = (msg, extra = {}) => { emit('result', { ok: false, text: msg }); return { ok: false, text: msg, ...extra }; };
  if (current) return refuse(`I'm still working on "${current.text.slice(0, 60)}". Say "stop" to cancel it first.`, { busy: true });
  const spent = spentThisMonth();
  if (spent >= cfg.budget.monthlyUsd) {
    return refuse(`This month's limit of $${cfg.budget.monthlyUsd} is used up ($${spent.toFixed(2)} spent). Raise it with "npm run setup" if you need more.`);
  }
  if (!cfg.apiKey && !process.env.ANTHROPIC_API_KEY) return refuse('No Anthropic API key yet. Run "npm run setup" on the laptop.');

  const proj = project && (project === GENERAL || cfg.projects[project]) ? project : (cfg.defaultProject || GENERAL);
  const cwd = proj === GENERAL ? os.homedir() : cfg.projects[proj];
  const projectDir = proj === GENERAL ? null : cwd;
  if (fresh) clearSession(proj);
  const resume = getSessions()[proj];

  const id = String(++jobSeq);
  const abort = new AbortController();
  current = { id, text, project: proj, abort, startedAt: Date.now() };
  emit('start', { jobId: id, text, project: proj, resumed: !!resume });
  pushHistory({ role: 'user', text, project: proj, at: Date.now() });

  let lastText = '';
  let final = { ok: false, text: '' };
  try {
    const q = query({
      prompt: text,
      options: {
        cwd,
        resume,
        model: cfg.model || undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt(cfg, proj, cwd) },
        settingSources: ['project'], // loads the project's CLAUDE.md / AGENTS.md
        mcpServers: { laptop: laptopServer() },
        permissionMode: 'default',
        canUseTool: makePolicy(projectDir, cfg),
        maxBudgetUsd: cfg.budget.perJobUsd,
        abortController: abort,
        env: agentEnv(cfg),
        stderr: d => { if (process.env.JARVIS_DEBUG) process.stderr.write(d); },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        setSession(proj, m.session_id);
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) { lastText = b.text.trim(); emit('say', { jobId: id, text: lastText }); }
          else if (b.type === 'tool_use') emit('step', { jobId: id, label: describeStep(b.name, b.input) });
        }
      } else if (m.type === 'result') {
        addSpend(m.total_cost_usd || 0);
        const ok = m.subtype === 'success' && !m.is_error;
        const reason = m.subtype === 'error_max_budget_usd' ? `I stopped because this task reached the $${cfg.budget.perJobUsd} limit per task.`
          : m.subtype === 'error_max_turns' ? 'I stopped because the task was taking too many steps.'
            : '';
        final = { ok, text: (ok ? (m.result || lastText) : (reason || m.result || lastText || 'Something went wrong.')).trim(), cost: m.total_cost_usd || 0 };
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    final = abort.signal.aborted ? { ok: false, text: 'Stopped.' }
      : /api.?key|auth|401|invalid x-api-key/i.test(msg) ? { ok: false, text: 'Anthropic rejected the API key. Check it with "npm run setup".' }
        : { ok: false, text: `Something went wrong: ${msg.slice(0, 300)}` };
  } finally {
    current = null;
  }
  if (!final.text) final.text = lastText || (final.ok ? 'Done.' : 'Something went wrong.');
  emit('result', { jobId: id, ok: final.ok, text: final.text, cost: final.cost || 0, spentThisMonth: spentThisMonth() });
  pushHistory({ role: 'assistant', text: final.text, ok: final.ok, project: proj, at: Date.now() });
  return final;
}
