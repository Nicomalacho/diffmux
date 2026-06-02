#!/usr/bin/env node
// cmux-diffx-bridge — pull review comments from a running diffx server and
// inject them into a cmux agent pane. Pair with inject.js (the floating
// "Send to agent" button injected into the diffx page via `cmux browser`).
//
//   node bridge.mjs [--diffx http://127.0.0.1:3433] [--surface <ref|uuid>]
//                   [--port 3434] [--no-submit]
//
// Default surface = $CMUX_SURFACE_ID (the pane that launched it).
//
// diffx comment shape (from its API):
//   { id, filePath, side, lineNumber, lineContent, body, status, createdAt, replies }
// We send every non-resolved comment, then PUT each to status:"resolved" so a
// second click never re-sends the same feedback.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const DIFFX = opt('--diffx', 'http://127.0.0.1:3433').replace(/\/$/, '');
const SURFACE = opt('--surface', process.env.CMUX_SURFACE_ID || '');
const PORT = parseInt(opt('--port', '3434'), 10);
const SUBMIT = !has('--no-submit');
const CMUX = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
const BUF = 'cmuxdiffx';

const cmux = (a) => execFileP(CMUX, a, { maxBuffer: 8 * 1024 * 1024 });
let busy = false;

function buildPrompt(cs) {
  const n = cs.length;
  const L = [
    `Code review feedback — please address the following ${n} comment${n === 1 ? '' : 's'} ` +
    `from my diffx review. Make the edits directly; ask only if something is ambiguous.`,
    '',
  ];
  cs.forEach((c, i) => {
    L.push(`${i + 1}. ${c.filePath}:${c.lineNumber}${c.side === 'old' ? ' (old side)' : ''}`);
    if (c.lineContent) L.push(`   code: ${String(c.lineContent).trim()}`);
    L.push(`   → ${String(c.body || '').trim().split('\n').join('\n     ')}`);
    for (const r of c.replies || []) {
      if (r && r.body) L.push(`     ↳ ${String(r.body).trim().split('\n').join('\n       ')}`);
    }
    L.push('');
  });
  return L.join('\n').replace(/\n+$/, '\n');
}

async function resolve(c) {
  try {
    await fetch(`${DIFFX}/api/comments/${c.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: c.body, status: 'resolved' }),
    });
  } catch { /* best effort */ }
}

async function push() {
  const all = await (await fetch(`${DIFFX}/api/comments`)).json();
  const open = (Array.isArray(all) ? all : []).filter((c) => c.status !== 'resolved');
  if (!open.length) return { sent: 0 };
  if (!SURFACE) throw new Error('no target surface (set --surface or CMUX_SURFACE_ID)');
  const prompt = buildPrompt(open);
  await cmux(['set-buffer', '--name', BUF, prompt]);
  await cmux(['paste-buffer', '--name', BUF, '--surface', SURFACE]);
  if (SUBMIT) await cmux(['send-key', '--surface', SURFACE, 'enter']);
  for (const c of open) await resolve(c);   // mark sent → never re-sent
  return { sent: open.length, prompt };
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const reply = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return reply(res, 200, { ok: true, rev: 'resolve-v2', diffx: DIFFX, surface: SURFACE || null, submit: SUBMIT });
  if (u.pathname === '/push' && req.method === 'POST') {
    if (busy) return reply(res, 200, { sent: 0, busy: true });   // guard against double-trigger
    busy = true;
    try { reply(res, 200, { ok: true, ...(await push()) }); }
    catch (e) { reply(res, 500, { error: String(e && e.message || e) }); }
    finally { busy = false; }
    return;
  }
  reply(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`cmux-diffx-bridge :${PORT}  diffx=${DIFFX}  surface=${SURFACE || '(none)'}  submit=${SUBMIT}`);
});
