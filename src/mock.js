// Practice mode (JARVIS_MOCK=1): pretends to work so the phone app can be tried without using AI credit.
import { emit, requestApproval } from './events.js';
import { pushHistory } from './config.js';
import * as laptop from './laptop.js';

let busy = false;
let jobSeq = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function runCommand(cfg, text, { project } = {}) {
  if (busy) { const t = 'Still working on the last one. Tap Stop first.'; emit('result', { ok: false, text: t }); return { ok: false, text: t, busy: true }; }
  busy = true;
  const id = 'm' + (++jobSeq);
  const proj = project || cfg.defaultProject || 'General';
  emit('start', { jobId: id, text, project: proj });
  pushHistory({ role: 'user', text, project: proj, at: Date.now() });
  let out;
  try {
    if (/screenshot/i.test(text)) {
      emit('step', { jobId: id, label: 'screenshot' });
      out = await laptop.screenshot();
    } else if (/battery|storage|info/i.test(text)) {
      emit('step', { jobId: id, label: 'system info' });
      out = await laptop.systemInfo();
    } else {
      emit('say', { jobId: id, text: `Practice mode: pretending to "${text}".` });
      for (const label of ['Reading App.js', 'Editing src/screens/Cycle.js', 'Checking it builds']) { emit('step', { jobId: id, label }); await wait(500); }
      const a = await requestApproval({ title: 'Push to GitHub', detail: 'git push origin main\nGia would get this as an update.', risk: 'high' });
      out = { ok: true, text: a.allow ? 'Done! (Practice mode: nothing was really changed or pushed.)' : 'Okay, I won\'t push it. (Practice mode.)' };
    }
  } finally { busy = false; }
  emit('result', { jobId: id, ok: out.ok, text: out.text, cost: 0 });
  pushHistory({ role: 'assistant', text: out.text, ok: out.ok, project: proj, at: Date.now() });
  return out;
}
