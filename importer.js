// 既存の Claude Code / Codex セッション(ターミナルで作ったもの)を一覧・取り込みする
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const MAX_MSGS = 300;

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function lines(text) {
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
const clip = (t, n) => String(t).replace(/\s+/g, ' ').trim().slice(0, n);

// Claude の user 発言から人間の入力だけ取り出す(コマンドタグ・ツール結果は除外)
function claudeUserText(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return '';
  const c = e.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  t = t.trim();
  return t.startsWith('<') ? '' : t;
}
function codexText(p) {
  return (p.content || []).map(b => b.text || '').join('\n').trim();
}
const codexHuman = t => t && !t.startsWith('<') && !t.startsWith('# AGENTS.md') && !t.startsWith('AGENTS.md');

function walk(dir, out) {
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.jsonl')) out.push({ file: p, mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

function listClaude() {
  const out = [];
  let dirs; try { dirs = fs.readdirSync(CLAUDE_DIR); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(CLAUDE_DIR, d);
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      let cwd = '', title = '';
      for (const e of lines(readHead(file, 96 * 1024))) {
        if (!cwd && e.cwd) cwd = e.cwd;
        if (!title) title = claudeUserText(e);
        if (cwd && title) break;
      }
      if (!title) continue; // 会話のない空セッションは除外
      out.push({ tool: 'claude', nativeId: n.slice(0, -6), file, cwd, title: clip(title, 80), mtime: st.mtimeMs });
    }
  }
  return out;
}

function listCodex() {
  const out = [];
  for (const { file, mtime } of walk(CODEX_DIR, [])) {
    let cwd = '', id = '', title = '';
    for (const e of lines(readHead(file, 256 * 1024))) {
      const p = e.payload || {};
      if (e.type === 'session_meta') { id = p.id || p.session_id || ''; cwd = p.cwd || ''; }
      else if (!title && e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const t = codexText(p); if (codexHuman(t)) title = t;
      }
      if (id && title) break;
    }
    if (!id || !title) continue;
    out.push({ tool: 'codex', nativeId: id, file, cwd, title: clip(title, 80), mtime });
  }
  return out;
}

function list() {
  return [...listClaude(), ...listCodex()].sort((a, b) => b.mtime - a.mtime);
}

function shortInput(inp) {
  if (!inp) return '';
  const v = inp.command || inp.file_path || inp.pattern || inp.path || inp.url || inp.description || inp.prompt || JSON.stringify(inp);
  return String(v).replace(/\s+/g, ' ').slice(0, 140);
}

function parseClaude(file) {
  const msgs = [];
  for (const e of lines(fs.readFileSync(file, 'utf8'))) {
    const ts = Date.parse(e.timestamp) || 0;
    const u = claudeUserText(e);
    if (u) { msgs.push({ role: 'user', text: u, ts }); continue; }
    if (e.type === 'assistant' && !e.isSidechain && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text && b.text.trim()) msgs.push({ role: 'assistant', text: b.text.trim(), ts });
        else if (b.type === 'tool_use') msgs.push({ role: 'tool', text: `${b.name}  ${shortInput(b.input)}`, ts });
      }
    }
  }
  return msgs;
}

function parseCodex(file) {
  const msgs = [];
  for (const e of lines(fs.readFileSync(file, 'utf8'))) {
    const p = e.payload || {};
    const ts = Date.parse(e.timestamp) || 0;
    if (e.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') { const t = codexText(p); if (codexHuman(t)) msgs.push({ role: 'user', text: t, ts }); }
    else if (p.type === 'message' && p.role === 'assistant') { const t = codexText(p); if (t) msgs.push({ role: 'assistant', text: t, ts }); }
    else if (p.type === 'function_call' || p.type === 'custom_tool_call') msgs.push({ role: 'tool', text: `${p.name || 'tool'}  ${clip(p.arguments || p.input || '', 140)}`, ts });
  }
  return msgs;
}

// 一覧に出たファイルだけ取り込める(任意パス読み取りの防止)
function load(item) {
  const msgs = item.tool === 'claude' ? parseClaude(item.file) : parseCodex(item.file);
  return msgs.slice(-MAX_MSGS);
}

// ---- 全文検索 ----
// 検索対象: 人間の発言 + ツール入力(ファイルパス/コマンド等)+ フォルダ名。mtimeでキャッシュ。
const norm = s => String(s).normalize('NFKC').toLowerCase();
const textCache = new Map(); // file -> { mtime, text }
const TEXT_CAP = 60000;

function buildText(item) {
  const parts = [item.cwd, item.title];
  let len = 0;
  const push = t => { if (t && len < TEXT_CAP) { parts.push(t); len += t.length; } };
  const raw = fs.readFileSync(item.file, 'utf8');
  for (const l of raw.split('\n')) {
    if (!l) continue;
    if (item.tool === 'claude') {
      if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"')) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.isSidechain) continue;
      const u = claudeUserText(e); if (u) { push(u.slice(0, 2000)); continue; }
      if (e.type === 'assistant' && e.message && Array.isArray(e.message.content))
        for (const b of e.message.content) if (b.type === 'tool_use') push(shortInput(b.input));
    } else {
      if (!l.includes('"response_item"')) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      const p = e.payload || {};
      if (p.type === 'message' && p.role === 'user') { const t = codexText(p); if (codexHuman(t)) push(t.slice(0, 2000)); }
      else if (p.type === 'function_call' || p.type === 'custom_tool_call') push(clip(p.arguments || p.input || '', 200));
    }
  }
  return norm(parts.join('\n'));
}

function textOf(item) {
  const c = textCache.get(item.file);
  if (c && c.mtime === item.mtime) return c.text;
  let text = '';
  try { text = buildText(item); } catch {}
  textCache.set(item.file, { mtime: item.mtime, text });
  return text;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 英数だけのキーワードは単語境界つきで数える(tbh が無関係な文字列に当たるのを防ぐ)
function kwRegex(k) {
  return /^[\x00-\x7f]+$/.test(k) ? new RegExp('(?<![a-z0-9])' + esc(k) + '(?![a-z0-9])', 'g') : new RegExp(esc(k), 'g');
}
function countOf(text, re) {
  re.lastIndex = 0;
  let n = 0;
  while (n < 6 && re.exec(text)) n++;
  return n;
}

// 検索: キーワードが珍しいほど(少数の会話にしか出ないほど)重く数える。
// ほぼ全会話に出る語(SPEC.md 等)は無視し、フォルダ名/題名に当たれば加点。
function search(items, keywords, limit = 20) {
  const ks = [...new Set(keywords.map(norm).map(k => k.trim()).filter(k => k.length >= 2))];
  const N = items.length || 1;
  const rows = items.map(it => ({ it, text: textOf(it), head: norm(it.cwd + ' ' + it.title) }));
  const kinfo = ks.map(k => {
    const re = kwRegex(k);
    const counts = rows.map(r => countOf(r.text, re));
    const df = counts.filter(n => n > 0).length;
    return { k, counts, df, w: df && df / N <= 0.3 ? Math.log((N + 1) / (df + 0.5)) : 0, re };
  });
  const out = [];
  rows.forEach((r, i) => {
    let score = 0;
    for (const ki of kinfo) {
      const n = ki.counts[i];
      if (!n || !ki.w) continue;
      score += ki.w * (1 + Math.min(n, 5) / 5) + (ki.re.test(r.head) ? ki.w : 0);
      ki.re.lastIndex = 0;
    }
    if (score > 0) out.push({ it: r.it, score });
  });
  out.sort((a, b) => b.score - a.score || b.it.mtime - a.it.mtime);
  return out.slice(0, limit).map(o => ({ nativeId: o.it.nativeId, tool: o.it.tool, score: Math.round(o.score * 10) / 10 }));
}

// 起動直後に裏で全文インデックスを作っておく(1件ずつ処理して画面操作を止めない)
async function warm(items) {
  for (const it of items) { textOf(it); await new Promise(r => setImmediate(r)); }
}

module.exports = { list, load, search, warm };
