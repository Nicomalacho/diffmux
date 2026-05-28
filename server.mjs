#!/usr/bin/env node
// cmux-review — review a git diff in cmux's embedded browser, leave inline
// comments, and pipe them straight into a running agent's pane via the cmux
// socket. No GitHub round-trip.
//
// Usage:
//   node server.mjs [--cwd <repo>] [--surface <ref|uuid>] [--port <n>]
//                   [--no-open] [--no-focus] [-- <git diff args...>]
//
// Defaults: cwd=$PWD, surface=$CMUX_SURFACE_ID, port=$CMUX_PORT, diff=HEAD
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const ddIdx = argv.indexOf('--');
const flags = ddIdx >= 0 ? argv.slice(0, ddIdx) : argv;
const diffSpec = ddIdx >= 0 ? argv.slice(ddIdx + 1) : ['HEAD'];
const opt = (name, def) => {
  const i = flags.indexOf(name);
  return i >= 0 && flags[i + 1] ? flags[i + 1] : def;
};
const has = (name) => flags.includes(name);

const cwd = path.resolve(opt('--cwd', process.cwd()));
const defaultSurface = opt('--surface', process.env.CMUX_SURFACE_ID || '');
const port = parseInt(opt('--port', process.env.CMUX_PORT || '0'), 10) || 0;
const noOpen = has('--no-open');
const focus = has('--no-focus') ? 'false' : 'true';
const workspaceId = process.env.CMUX_WORKSPACE_ID || '';
const CMUX = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
const BUFNAME = 'cmuxreview';

// ---- shell helpers ----------------------------------------------------
const git = async (args) =>
  (await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
const cmux = async (args) =>
  (await execFileP(CMUX, args, { maxBuffer: 8 * 1024 * 1024 })).stdout;

async function getDiff() {
  try {
    return await git(['diff', ...diffSpec]);
  } catch {
    return await git(['diff']); // fall back to working-tree diff
  }
}

// Enumerate terminal surfaces in this workspace so the UI can offer a picker.
async function getSurfaces() {
  try {
    const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
    const panes = JSON.parse(await cmux(['list-panes', ...wsArgs, '--json'])).panes || [];
    const out = [];
    for (const p of panes) {
      try {
        const so = JSON.parse(
          await cmux(['list-pane-surfaces', '--pane', p.ref, ...wsArgs, '--json'])
        );
        for (const s of so.surfaces || []) {
          if (s.type === 'terminal')
            out.push({ ref: s.ref, title: (s.title || '').trim(), pane: p.ref });
        }
      } catch { /* ignore a pane we can't read */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ---- prompt builder ---------------------------------------------------
function buildPrompt(comments, summary) {
  const lines = [];
  const n = comments.length;
  lines.push(
    `Code review feedback — please address the following ${n} comment${n === 1 ? '' : 's'} ` +
    `on the current diff. Make the edits directly; ask only if something is ambiguous.`
  );
  lines.push('');
  comments.forEach((c, i) => {
    const loc = c.newNo ? `${c.file}:${c.newNo}` : `${c.file} (line ${c.oldNo || '?'})`;
    lines.push(`${i + 1}. ${loc}`);
    if (c.code) lines.push(`   code: ${c.code.trim()}`);
    lines.push(`   → ${c.body.trim().split('\n').join('\n     ')}`);
    lines.push('');
  });
  if (summary && summary.trim()) {
    lines.push(`General notes: ${summary.trim()}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ---- inject into the agent pane --------------------------------------
async function sendToAgent(surface, prompt, submit) {
  if (!surface) throw new Error('no target surface');
  await cmux(['set-buffer', '--name', BUFNAME, prompt]);
  await cmux(['paste-buffer', '--name', BUFNAME, '--surface', surface]);
  if (submit) await cmux(['send-key', '--surface', surface, 'enter']);
}

// ---- http -------------------------------------------------------------
const INDEX = readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && url.pathname === '/api/context') {
      return json(res, 200, {
        cwd,
        repo: path.basename(cwd),
        range: diffSpec.join(' '),
        defaultSurface,
        surfaces: await getSurfaces(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/diff') {
      return json(res, 200, { diff: await getDiff(), range: diffSpec.join(' ') });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readBody(req);
      const surface = body.surface || defaultSurface;
      const comments = Array.isArray(body.comments) ? body.comments : [];
      if (!comments.length) return json(res, 400, { error: 'no comments' });
      const prompt = buildPrompt(comments, body.summary);
      await sendToAgent(surface, prompt, body.submit !== false);
      return json(res, 200, { ok: true, surface, prompt });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(port, '127.0.0.1', async () => {
  const real = server.address().port;
  const link = `http://127.0.0.1:${real}/`;
  console.log(`cmux-review  repo=${path.basename(cwd)}  range="${diffSpec.join(' ')}"`);
  console.log(`             target surface=${defaultSurface || '(none — pick in UI)'}`);
  console.log(`             ${link}`);
  if (!noOpen) {
    try {
      await cmux(['browser', 'open', link, '--focus', focus]);
      console.log('             opened in cmux browser pane');
    } catch (e) {
      console.log(`             (open in your browser — auto-open failed: ${e.message})`);
    }
  }
  console.log('Ctrl-C to stop.');
});
