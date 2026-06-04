#!/usr/bin/env node
// hunk-bridge — poll a live Hunk session for human ("user") inline review
// comments and paste them into a cmux agent pane. The terminal-native sibling
// of bridge.mjs: where bridge.mjs pulls from diffx's HTTP API, this shells out
// to `hunk session comment list --type user --json` (the local Hunk daemon).
//
//   node hunk-bridge.mjs [--repo <path>] [--surface <ref|uuid>] [--type user]
//                        [--interval 1500] [--debounce 2500] [--port 3437]
//                        [--no-submit]
//
// Trigger model: hunk is a TUI, so there's no "Send to agent" button to inject.
// Instead we poll and auto-deliver: when new user comments appear and then the
// review goes quiet for --debounce ms, the batch is pasted into the agent pane.
// A POST /push endpoint force-delivers immediately (parity / scripting / tests).
//
// Comment shape (from `hunk session comment list --json`):
//   { noteId, source, filePath, hunkIndex, newRange:[s,e]|oldRange:[s,e], body,
//     author, createdAt, editable }
// Dedup is by noteId, so a comment is never delivered twice.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const REPO = opt('--repo', process.cwd());
const SURFACE = opt('--surface', process.env.CMUX_SURFACE_ID || '');
const TYPE = opt('--type', 'user');                       // user | all | agent | ai | live
const INTERVAL = parseInt(opt('--interval', '1500'), 10); // poll cadence
const DEBOUNCE = parseInt(opt('--debounce', '2500'), 10); // quiet period before auto-send
const PORT = parseInt(opt('--port', '3437'), 10);
const SUBMIT = !has('--no-submit');
const CMUX = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
const HUNK = process.env.HUNK_BIN || 'hunk';
const BUF = 'cmuxhunk';

const cmux = (a) => execFileP(CMUX, a, { maxBuffer: 8 * 1024 * 1024 });
const seen = new Set();   // noteIds already delivered
let pending = [];         // new comments awaiting the debounce window
let lastChange = 0;
let busy = false;

async function listComments() {
  const { stdout } = await execFileP(
    HUNK, ['session', 'comment', 'list', '--repo', REPO, '--type', TYPE, '--json'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout);
  return Array.isArray(j.comments) ? j.comments : [];
}

function locate(c) {
  const r = c.newRange || c.oldRange || [];
  return { line: r[0], side: c.newRange ? '' : c.oldRange ? ' (old side)' : '' };
}

function buildPrompt(cs) {
  const n = cs.length;
  const L = [
    `Code review feedback — please address the following ${n} comment${n === 1 ? '' : 's'} ` +
    `from my Hunk review. Make the edits directly; ask only if something is ambiguous.`,
    '',
  ];
  cs.forEach((c, i) => {
    const { line, side } = locate(c);
    L.push(`${i + 1}. ${c.filePath}:${line}${side}`);
    L.push(`   → ${String(c.body || '').trim().split('\n').join('\n     ')}`);
    L.push('');
  });
  return L.join('\n').replace(/\n+$/, '\n');
}

async function deliver(cs) {
  if (!SURFACE) throw new Error('no target surface (set --surface or CMUX_SURFACE_ID)');
  const prompt = buildPrompt(cs);
  await cmux(['set-buffer', '--name', BUF, prompt]);            // multi-line via bracketed paste
  await cmux(['paste-buffer', '--name', BUF, '--surface', SURFACE]);
  if (SUBMIT) await cmux(['send-key', '--surface', SURFACE, 'enter']);
}

async function tick() {
  if (busy) return;
  let comments;
  try { comments = await listComments(); }
  catch { return; }   // no live session yet / daemon hiccup — try again next tick
  // "incoming" = not yet delivered AND not already queued, so a comment only
  // resets the debounce window on the tick it first appears (not every tick).
  const incoming = comments.filter((c) => !seen.has(c.noteId) && !pending.some((p) => p.noteId === c.noteId));
  if (incoming.length) {
    pending.push(...incoming);
    lastChange = Date.now();
    return;             // reviewer is still adding — hold for the quiet window
  }
  if (pending.length && Date.now() - lastChange >= DEBOUNCE) {
    busy = true;
    const batch = pending; pending = [];
    try {
      await deliver(batch);
      for (const c of batch) seen.add(c.noteId);
      console.log(`delivered ${batch.length} comment(s) -> ${SURFACE}`);
    } catch (e) {
      pending = batch.concat(pending);   // put back, retry next tick
      console.error('deliver failed:', e && e.message || e);
    } finally { busy = false; }
  }
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const reply = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') {
    return reply(res, 200, { ok: true, repo: REPO, surface: SURFACE || null, type: TYPE, seen: seen.size, pending: pending.length });
  }
  if (u.pathname === '/push' && req.method === 'POST') {
    if (busy) return reply(res, 200, { sent: 0, busy: true });
    busy = true;
    try {
      const comments = await listComments();
      const fresh = comments.filter((c) => !seen.has(c.noteId));
      if (fresh.length) { await deliver(fresh); for (const c of fresh) seen.add(c.noteId); }
      pending = pending.filter((p) => !seen.has(p.noteId));
      reply(res, 200, { sent: fresh.length });
    } catch (e) { reply(res, 500, { error: String(e && e.message || e) }); }
    finally { busy = false; }
    return;
  }
  reply(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`hunk-bridge :${PORT}  repo=${REPO}  surface=${SURFACE || '(none)'}  type=${TYPE}  poll=${INTERVAL}ms debounce=${DEBOUNCE}ms`);
});

setInterval(tick, INTERVAL);
