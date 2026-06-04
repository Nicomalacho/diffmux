#!/usr/bin/env node
// pierre-server — serves the @pierre/diffs review UI (pierre/index.html +
// pierre/dist), computes the git diff, and pastes reviewer comments into a cmux
// agent pane. We own this UI, so the send-to-agent loop is folded into the
// server (no separate bridge like diffx needs).
//
//   node pierre-server.mjs --cwd <repo> --port 3500 --surface <ref> [--no-submit] -- <git diff args>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dd = argv.indexOf('--');
const DIFF_ARGS = dd >= 0 ? argv.slice(dd + 1) : [];
const CWD = opt('--cwd', process.cwd());
const WORKSPACE = opt('--workspace', '');   // a feature dir holding multiple repo worktrees
const PORT = parseInt(opt('--port', '3500'), 10);
const SURFACE = opt('--surface', process.env.CMUX_SURFACE_ID || '');
const SUBMIT = !argv.includes('--no-submit');
const CMUX = process.env.CMUX_BUNDLED_CLI_PATH || 'cmux';
const BUF = 'cmuxpierre';
const DIR = path.join(__dirname, 'pierre');   // holds index.html + dist/

const cmux = (a) => execFileP(CMUX, a, { maxBuffer: 8 * 1024 * 1024 });

async function gitDiff() {
  const { stdout } = await execFileP('git', ['-C', CWD, 'diff', ...DIFF_ARGS], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Per-file add/del counts (the patch metadata's *Lines fields are content, not counts).
async function gitStats() {
  const { stdout } = await execFileP('git', ['-C', CWD, 'diff', '--numstat', ...DIFF_ARGS], { maxBuffer: 16 * 1024 * 1024 });
  return parseNumstat(stdout);
}

function parseNumstat(stdout, prefix = '') {
  const stats = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) stats[prefix + m[3]] = { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2] };
  }
  return stats;
}

// ---- workspace mode: aggregate every changed repo under a feature dir ----
// Each repo's files are namespaced `<repo>/<path>` (via git's --src/--dst-prefix)
// so they don't collide and the UI can group by repo. Base branch per repo comes
// from its .feature-cli.json (default "develop").
function discoverRepos(featureDir) {
  const out = [];
  let names;
  try { names = fs.readdirSync(featureDir).sort(); } catch { return out; }
  for (const name of names) {
    const dir = path.join(featureDir, name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;   // worktree .git is a file — existsSync is fine
    let base = 'develop';
    try { base = JSON.parse(fs.readFileSync(path.join(dir, '.feature-cli.json'), 'utf8')).base_branch || base; } catch { /* default */ }
    out.push({ repo: name, dir, base });
  }
  return out;
}

async function repoDiff(r) {
  const range = `origin/${r.base}...HEAD`;
  let patch = '';
  try {
    const { stdout } = await execFileP('git',
      ['-C', r.dir, 'diff', `--src-prefix=a/${r.repo}/`, `--dst-prefix=b/${r.repo}/`, range],
      { maxBuffer: 64 * 1024 * 1024 });
    patch = stdout;
  } catch { return null; }   // base ref missing, etc.
  if (!patch.trim()) return null;
  let stats = {};
  try {
    const { stdout } = await execFileP('git', ['-C', r.dir, 'diff', '--numstat', range], { maxBuffer: 16 * 1024 * 1024 });
    stats = parseNumstat(stdout, `${r.repo}/`);
  } catch { /* counts optional */ }
  return { patch, stats };
}

async function workspaceDiff() {
  const repos = discoverRepos(WORKSPACE);
  const results = await Promise.all(repos.map(repoDiff));
  let patch = '';
  const stats = {};
  for (const d of results) { if (!d) continue; patch += d.patch; Object.assign(stats, d.stats); }
  return { patch, stats };
}

function buildPrompt(cs) {
  const n = cs.length;
  const where = WORKSPACE
    ? `from my @pierre/diffs workspace review. Paths are \`<repo>/<file>\`; the repos live under ${WORKSPACE}/<repo>.`
    : `from my @pierre/diffs review.`;
  const L = [
    `Code review feedback — please address the following ${n} comment${n === 1 ? '' : 's'} ` +
    `${where} Make the edits directly; ask only if something is ambiguous.`,
    '',
  ];
  cs.forEach((c, i) => {
    const side = c.side === 'deletions' ? ' (old side)' : '';
    L.push(`${i + 1}. ${c.path}:${c.line}${side}`);
    L.push(`   → ${String(c.body || '').trim().split('\n').join('\n     ')}`);
    L.push('');
  });
  return L.join('\n').replace(/\n+$/, '\n');
}

async function send(cs) {
  if (!SURFACE) throw new Error('no target surface (set --surface or CMUX_SURFACE_ID)');
  const prompt = buildPrompt(cs);
  await cmux(['set-buffer', '--name', BUF, prompt]);
  await cmux(['paste-buffer', '--name', BUF, '--surface', SURFACE]);
  if (SUBMIT) await cmux(['send-key', '--surface', SURFACE, 'enter']);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm' };
function serveFile(res, fp) {
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') return serveFile(res, path.join(DIR, 'index.html'));
    if (u.pathname === '/scrollfix.js') return serveFile(res, path.join(__dirname, 'scrollfix.js'));   // webview scroll-jump shim
    if (u.pathname.startsWith('/dist/')) {
      const fp = path.normalize(path.join(DIR, u.pathname));
      if (!fp.startsWith(path.join(DIR, 'dist'))) { res.writeHead(403); return res.end(); }
      return serveFile(res, fp);
    }
    if (u.pathname === '/api/diff') {
      let patch, stats;
      if (WORKSPACE) ({ patch, stats } = await workspaceDiff());
      else [patch, stats] = await Promise.all([gitDiff(), gitStats()]);
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ patch, stats, workspace: WORKSPACE ? path.basename(WORKSPACE) : null }));
    }
    if (u.pathname === '/api/send' && req.method === 'POST') {
      let body = ''; for await (const ch of req) body += ch;
      const { comments = [] } = JSON.parse(body || '{}');
      if (!comments.length) { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify({ sent: 0 })); }
      await send(comments);
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ sent: comments.length }));
    }
    res.writeHead(404, cors); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`pierre-server :${PORT}  ${WORKSPACE ? `workspace=${WORKSPACE}` : `cwd=${CWD}  diffArgs=[${DIFF_ARGS.join(' ')}]`}  surface=${SURFACE || '(none)'}`);
});
