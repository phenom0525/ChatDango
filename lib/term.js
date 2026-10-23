'use strict';
// ブラウザ内ターミナル(任意機能)。vendor/node-pty が無ければ無効のまま。消せばすぐ元に戻る。
const path = require('path');
let pty = null;
try { pty = require(path.join(__dirname, '..', 'vendor', 'node-pty')); } catch { pty = null; }

const terms = new Map(); // id -> { p, buf, subs:Set<res>, cwd, alive }
const BUF_MAX = 200 * 1024;
let seq = 0;

const available = () => !!pty;

function open({ cwd, cols, rows }) {
  if (!pty) throw new Error('ターミナル部品(vendor/node-pty)が入っていません');
  const id = 't' + (++seq) + '-' + Date.now().toString(36);
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const args = process.platform === 'win32' ? ['-NoLogo'] : [];
  const p = pty.spawn(shell, args, { name: 'xterm-256color', cols: Math.min(400, Math.max(20, cols | 0 || 100)), rows: Math.min(200, Math.max(5, rows | 0 || 24)), cwd, env: process.env });
  const t = { p, buf: '', subs: new Set(), cwd, alive: true };
  terms.set(id, t);
  p.onData(d => {
    t.buf = (t.buf + d).slice(-BUF_MAX);
    const m = 'data: ' + Buffer.from(d).toString('base64') + '\n\n';
    for (const r of t.subs) { try { r.write(m); } catch {} }
  });
  p.onExit(() => {
    t.alive = false;
    for (const r of t.subs) { try { r.write('event: exit\ndata: 1\n\n'); r.end(); } catch {} }
    t.subs.clear();
    setTimeout(() => terms.delete(id), 60000);
  });
  return id;
}

function attach(id, res) {
  const t = terms.get(id); if (!t) return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
  if (t.buf) res.write('data: ' + Buffer.from(t.buf).toString('base64') + '\n\n');
  if (!t.alive) { res.write('event: exit\ndata: 1\n\n'); return res.end(), true; }
  t.subs.add(res); res.on('close', () => t.subs.delete(res));
  return true;
}

const input = (id, d) => { const t = terms.get(id); if (!t || !t.alive) return false; t.p.write(String(d).slice(0, 65536)); return true; };
const resize = (id, cols, rows) => { const t = terms.get(id); if (!t || !t.alive) return false; try { t.p.resize(Math.min(400, Math.max(20, cols | 0)), Math.min(200, Math.max(5, rows | 0))); } catch {} return true; };
const close = id => { const t = terms.get(id); if (!t) return false; try { t.p.kill(); } catch {} terms.delete(id); return true; };
const list = () => [...terms].filter(([, t]) => t.alive).map(([id, t]) => ({ id, cwd: t.cwd }));
const closeAll = () => { for (const id of [...terms.keys()]) close(id); };

module.exports = { available, open, attach, input, resize, close, list, closeAll };
