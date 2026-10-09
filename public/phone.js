// Phone mode: Jarvis talks to Claude directly from the phone (no laptop). Claude can search the web,
// read links, remember things about you, and run cloud coding tasks on your GitHub repos.
import * as GH from './github.js';

export const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet (fast, everyday)'],
  ['claude-opus-5-5', 'Opus (smartest, slower)'],
];
const API = 'https://api.anthropic.com/v1/messages';

export async function callClaude({ key, model, system, messages, tools, maxTokens = 8000 }) {
  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true', // allowed: the key is yours and lives only on this phone
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools, output_config: { effort: 'medium' } }),
    });
  } catch { throw new Error("Couldn't reach Anthropic. Check your connection."); }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.error?.message || `HTTP ${r.status}`;
    if (r.status === 401) throw new Error('Anthropic rejected the API key. Check it in Settings.');
    if (/credit balance/i.test(msg)) throw new Error('Your Anthropic account is out of credit. Top up in the Claude Console.');
    if (r.status === 429 || r.status === 529) throw new Error('Claude is busy right now. Try again in a minute.');
    throw new Error(`Claude error: ${msg}`);
  }
  return j;
}

export async function testKey(key) {
  try {
    await callClaude({ key, model: MODELS[0][0], system: 'Reply with OK.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 16 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---- tools ----
const SERVER_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'GB', timezone: 'Europe/London' } },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, citations: { enabled: true }, max_content_tokens: 40000 },
];
const CLIENT_TOOLS = [
  { name: 'remember', description: 'Save a lasting fact or preference about the user to memory (e.g. "Prefers short answers", "Partner is Gia"). Only for things worth remembering long-term.', input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'list_my_repos', description: "List the user's GitHub repositories (most recently updated first).", input_schema: { type: 'object', properties: {} } },
  { name: 'start_coding_task', description: 'Start a cloud coding task on one of the user\'s GitHub repos. Claude Code runs in GitHub Actions, makes the change on a separate branch and reports back; nothing ships until the user approves. The user is asked to confirm first. Write complete, self-contained instructions: the cloud coder cannot see this chat.', input_schema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, title: { type: 'string', description: 'Short task title' }, instructions: { type: 'string', description: 'Full instructions with acceptance criteria' } }, required: ['repo', 'title', 'instructions'] } },
  { name: 'list_coding_tasks', description: 'List recent cloud coding tasks and their status (queued, working, ready, answered, failed, shipped, discarded).', input_schema: { type: 'object', properties: {} } },
  { name: 'revise_coding_task', description: 'Send follow-up instructions to an existing cloud coding task (e.g. changes the user asked for after seeing it).', input_schema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, feedback: { type: 'string' } }, required: ['repo', 'number', 'feedback'] } },
  { name: 'ship_coding_task', description: 'Ship a finished task: open a pull request from its branch and merge it into the main branch. For Gia Mia this builds a new app version that Gia receives. The user is asked to approve and sees what changed first.', input_schema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] } },
];

export function systemPrompt(s) {
  const now = new Date();
  const when = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  return `You are ${s.name}, ${s.owner}'s personal AI assistant, in phone mode: you're running on his iPhone and his laptop isn't involved. It is ${when} (UK time). ${s.owner} lives in the UK.

What you can do here:
- Answer anything, think things through, write, plan, explain, and help with decisions.
- Search the web (web_search) for anything current, and read links he pastes or pages you find (web_fetch). Mention where facts came from.
- Remember lasting facts about him with remember (only when he asks or it's clearly useful later).
- Run cloud coding tasks on his GitHub repos: start_coding_task, list_coding_tasks, revise_coding_task, ship_coding_task. Claude Code does the work in GitHub Actions on a branch; nothing ships until he approves. Tasks take a few minutes; he can follow them in the Tasks tab. ${s.repos.length ? `His project repos: ${s.repos.join(', ')}.` : 'He has not listed project repos yet; use list_my_repos.'}
- You can't control his laptop or phone in this mode. For laptop things (files, apps, screenshots), tell him that needs laptop mode, which works when the laptop is on with Jarvis running.

Style: friendly, direct and concise; this is a phone and replies may be read aloud. Use short paragraphs; short lists only when they help. No tables.

When writing coding-task instructions, be specific and complete: goal, where in the app, exact behaviour, edge cases, and "how to check it works". For Gia Mia (nagarearyan92-code/gia-foodtracker): an Expo Android app ${s.owner} made for his partner Gia. Keep her saved data compatible, update WHATS_NEW.md with a short warm note for Gia, and make sure it still bundles. Shipping it (merging to main) builds a new version she gets through the app's Update button.

What you know about ${s.owner}:
${s.memory.trim() || '(nothing saved yet)'}`;
}

// Keep the last N user turns, never splitting tool calls from their results.
export function trimHistory(messages, turns = 12) {
  const starts = messages.map((m, i) => (m.role === 'user' && (typeof m.content === 'string' || !m.content.some?.(b => b.type === 'tool_result')) ? i : -1)).filter(i => i >= 0);
  const from = starts.length > turns ? starts[starts.length - turns] : (starts[0] ?? 0);
  let out = messages.slice(from);
  while (out.length > 2 && JSON.stringify(out).length > 1_500_000) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user' && (typeof m.content === 'string' || !m.content.some?.(b => b.type === 'tool_result')));
    if (next <= 0) break;
    out = out.slice(next);
  }
  return out;
}

const isTurnStart = m => m.role === 'user' && typeof m.content === 'string';
const textOf = m => (typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('')).trim();

// Makes stored history safe and small before sending it:
// - older turns are squeezed to just the words said (no web pages, tool calls or thinking),
// - an unfinished turn (a tool call with no result, e.g. after a cut-off reply) is closed off,
// so one bad turn can't break every message after it.
export function compact(messages, keepFull = 2) {
  const starts = messages.map((m, i) => (isTurnStart(m) ? i : -1)).filter(i => i >= 0);
  const out = [];
  starts.forEach((st, k) => {
    const turn = messages.slice(st, k + 1 < starts.length ? starts[k + 1] : messages.length);
    const full = k >= starts.length - keepFull && turnIsComplete(turn);
    if (full) { out.push(...turn); return; }
    const said = turn.filter(m => m.role === 'assistant').map(textOf).filter(Boolean).join('\n\n');
    out.push({ role: 'user', content: turn[0].content });
    out.push({ role: 'assistant', content: said || '(no reply)' });
  });
  return out;
}
function turnIsComplete(turn) {
  for (let i = 0; i < turn.length; i++) {
    const m = turn[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
    if (!ids.length) continue;
    const next = turn[i + 1];
    const got = new Set((next && Array.isArray(next.content) ? next.content : []).filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
    if (!ids.every(id => got.has(id))) return false;
  }
  const last = turn[turn.length - 1];
  return last.role === 'assistant';
}

const label = (name, input = {}) => ({
  web_search: `Searching the web: ${input.query || ''}`,
  web_fetch: `Reading ${String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60)}`,
  remember: 'Saving to memory',
  list_my_repos: 'Checking your GitHub repos',
  start_coding_task: `Starting a coding task on ${input.repo || 'GitHub'}`,
  list_coding_tasks: 'Checking coding tasks',
  revise_coding_task: `Sending changes to task #${input.number}`,
  ship_coding_task: `Shipping task #${input.number}`,
}[name] || name);
export const stepLabel = label;

// Runs one user message through Claude, including any tool calls. hooks: { onStep, onText, approve, settings, saveMemory }
export async function runTurn(history, userText, hooks) {
  const s = hooks.settings;
  const api = s.githubToken ? GH.client(s.githubToken) : null;
  const tools = [...SERVER_TOOLS, ...CLIENT_TOOLS];
  let messages = [...compact(trimHistory(history)), { role: 'user', content: userText }];
  const ask = async () => {
    try { return await callClaude({ key: s.anthropicKey, model: s.model, system: systemPrompt(s), messages, tools }); }
    catch (e) {
      // Too long, or history the API won't accept: retry once with only the words of earlier turns.
      if (!/Claude error/.test(e.message)) throw e;
      const cur = messages.slice(messages.map(isTurnStart).lastIndexOf(true));
      messages = [...compact(messages.slice(0, messages.length - cur.length), 0).slice(-16), ...cur];
      return callClaude({ key: s.anthropicKey, model: s.model, system: systemPrompt(s), messages, tools });
    }
  };
  const needGH = () => { if (!api) throw new Error('No GitHub token in Settings, so I can\'t reach GitHub yet.'); };

  async function runTool(name, input) {
    switch (name) {
      case 'remember': hooks.saveMemory(input.fact); return 'Saved.';
      case 'list_my_repos': needGH(); return JSON.stringify((await GH.myRepos(api)).slice(0, 40));
      case 'list_coding_tasks': needGH(); return JSON.stringify(await GH.listTasks(api, s.repos.length ? s.repos : (await GH.myRepos(api)).slice(0, 5).map(r => r.full)));
      case 'start_coding_task': {
        needGH();
        if (!(await GH.hasCloudCoder(api, input.repo))) return `This repo (${input.repo}) isn't set up for cloud coding yet: it needs .github/workflows/claude.yml, the Claude GitHub app and an ANTHROPIC_API_KEY secret (see Jarvis README). Tell the user.`;
        const ok = await hooks.approve({ title: `Start a coding task on ${input.repo}`, detail: `${input.title}\n\n${input.instructions}`, risk: 'medium', yes: 'Start' });
        if (!ok) return 'The user said not to start it. Ask what they would like instead.';
        const t = await GH.startTask(api, input.repo, input.title, input.instructions);
        hooks.onTask?.(t);
        return `Started task #${t.number} (${t.url}). It usually takes a few minutes; the user can follow it in the Tasks tab.`;
      }
      case 'revise_coding_task': needGH(); await GH.reviseTask(api, input.repo, input.number, input.feedback); return 'Sent. Claude will pick it up in a minute or two.';
      case 'ship_coding_task': {
        needGH();
        const tasks = await GH.listTasks(api, [input.repo]);
        const t = tasks.find(x => x.number === input.number);
        if (!t) return 'Task not found.';
        if (t.status !== 'ready' || !t.branch) return `Task #${t.number} isn't ready to ship (status: ${t.status}).`;
        const d = await GH.diffSummary(api, t.repo, t.branch);
        const files = d.files.map(f => `${f.name} (+${f.add} −${f.del})`).join('\n');
        const ok = await hooks.approve({ title: `Ship "${t.title}" to ${t.repo}`, detail: `${d.files.length} file(s) changed:\n${files}${/gia-foodtracker/.test(t.repo) ? '\n\nGia will get this as an app update.' : ''}`, risk: 'high', yes: 'Ship it' });
        if (!ok) return 'The user chose not to ship it.';
        const r = await GH.shipTask(api, t.repo, t.number, t.branch, t.title);
        return `Shipped: merged PR #${r.pr}.${/gia-foodtracker/.test(t.repo) ? ' GitHub is now building the new Gia Mia version (about 15 minutes).' : ''}`;
      }
      default: return `Unknown tool ${name}`;
    }
  }

  for (let round = 0; round < 10; round++) {
    let res = await ask();
    if (res.stop_reason === 'max_tokens' && !res.content.some(b => b.type === 'text' && b.text.trim())) {
      // Ran out of room while thinking: one more go with extra room.
      res = await callClaude({ key: s.anthropicKey, model: s.model, system: systemPrompt(s), messages, tools, maxTokens: 20000 });
    }
    messages.push({ role: 'assistant', content: res.content });
    for (const b of res.content) {
      if (b.type === 'server_tool_use') hooks.onStep(label(b.name, b.input));
      if (b.type === 'text' && b.text.trim()) hooks.onText?.(b.text);
    }
    hooks.onUsage?.(res.usage);
    if (res.stop_reason === 'pause_turn') continue; // long web research: let Claude carry on
    if (res.stop_reason !== 'tool_use') break;
    const results = [];
    for (const b of res.content.filter(x => x.type === 'tool_use')) {
      hooks.onStep(label(b.name, b.input));
      let content, is_error = false;
      try { content = await runTool(b.name, b.input || {}); } catch (e) { content = e.message; is_error = true; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: String(content).slice(0, 20000), is_error });
    }
    messages.push({ role: 'user', content: results });
  }
  return messages;
}

// What to show for a stored conversation: [{ who: 'me'|'ai'|'step', text, sources }]
export function renderable(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ who: 'me', text: m.content });
      continue;
    }
    let text = '';
    const sources = new Map();
    for (const b of m.content || []) {
      if (b.type === 'server_tool_use' || b.type === 'tool_use') out.push({ who: 'step', text: label(b.name, b.input) });
      if (b.type === 'text') {
        text += b.text;
        for (const c of b.citations || []) if (c.url) sources.set(c.url, c.title || c.url);
      }
    }
    if (text.trim()) out.push({ who: 'ai', text: text.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) });
  }
  return out;
}
