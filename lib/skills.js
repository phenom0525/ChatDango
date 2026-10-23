'use strict';
// スキルの一覧と、別のツールへのコピー。Claude Code と Codex のスキル置き場を同じ書式(SKILL.md)として扱う。
//   Claude Code: ~/.claude/skills            作業フォルダの .claude/skills
//   Codex      : ~/.codex/skills, ~/.agents/skills   作業フォルダの .codex/skills, .agents/skills
const fs = require('fs');
const path = require('path');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // フォルダ名として安全なもの(コピー先に使う)
const LIMIT = { files: 500, bytes: 20 * 1024 * 1024 };
const SKIP = new Set(['.git', 'node_modules', '__pycache__']);

// SKILL.md 先頭の --- で囲まれた部分から、最上位のキーを読む。| や > の複数行・引用符・インデントつきの続きの行に対応
function parseMeta(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').slice(0, 30000));
  if (!m) return {};
  const lines = m[1].split(/\r?\n/), out = {};
  for (let i = 0; i < lines.length; i++) {
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!k) continue;
    let v = k[2].trim();
    const block = /^[|>][+-]?$/.test(v), buf = block ? [] : [v];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (block && lines[i + 1] === ''))) buf.push(lines[++i].trim());
    v = buf.join(' ').replace(/\s+/g, ' ').trim();
    out[k[1]] = block ? v : v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// 置き場の一覧: [{tool, scope, dir}]
function roots(home, cwd) {
  const r = [
    { tool: 'claude', scope: 'personal', dir: path.join(home, '.claude', 'skills') },
    { tool: 'codex', scope: 'personal', dir: path.join(home, '.codex', 'skills') },
    { tool: 'codex', scope: 'personal', dir: path.join(home, '.agents', 'skills') },
  ];
  if (cwd) r.push(
    { tool: 'claude', scope: 'project', dir: path.join(cwd, '.claude', 'skills') },
    { tool: 'codex', scope: 'project', dir: path.join(cwd, '.codex', 'skills') },
    { tool: 'codex', scope: 'project', dir: path.join(cwd, '.agents', 'skills') });
  return r;
}

// 置き場をすべて走査して、スキル1件ずつの配列にする。SKILL.md が無いフォルダ・「.」で始まるフォルダは除く
function scan(home, cwd) {
  const out = [];
  for (const r of roots(home, cwd)) {
    let ents; try { ents = fs.readdirSync(r.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const dir = path.join(r.dir, e.name);
      let st; try { st = fs.statSync(dir); } catch { continue; } // リンク先が消えていたら除く
      if (!st.isDirectory()) continue;
      let text; try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
      const meta = parseMeta(text);
      out.push({ name: String(meta.name || e.name).trim().slice(0, 80), dirName: e.name, desc: String(meta.description || '').slice(0, 300), version: String(meta.version || '').slice(0, 20), tool: r.tool, scope: r.scope, dir, link: e.isSymbolicLink() });
    }
  }
  return out;
}

// 同じ名前のスキルを1行にまとめる。tools にはそのスキルを使えるツール(重複なし)
function group(entries) {
  const m = new Map();
  for (const x of entries) {
    const k = x.name.toLowerCase();
    let g = m.get(k); if (!g) m.set(k, g = { name: x.name, desc: x.desc, tools: [], places: [] });
    if (!g.desc && x.desc) g.desc = x.desc;
    if (!g.tools.includes(x.tool)) g.tools.push(x.tool);
    g.places.push({ tool: x.tool, scope: x.scope, dir: x.dir, dirName: x.dirName, link: x.link, version: x.version });
  }
  for (const g of m.values()) g.tools.sort();
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// コピー先の置き場(同じ範囲=個人/作業フォルダのまま、もう一方のツールへ)。Codex は新しい標準の .agents/skills に置く
function destRoot(home, cwd, toTool, scope) {
  const base = scope === 'project' ? cwd : home;
  if (!base) return null;
  return path.join(base, toTool === 'codex' ? '.agents' : '.claude', 'skills');
}

// フォルダの中身の数と大きさ(リンクはたどる)。上限を超えたら null
function measure(dir) {
  let files = 0, bytes = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name), st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); } else { files++; bytes += st.size; }
      if (files > LIMIT.files || bytes > LIMIT.bytes) throw new Error('limit');
    }
  };
  try { walk(dir); } catch { return null; }
  return { files, bytes };
}

// entry を toTool の置き場へコピーする。上書きはしない。戻り値 { ok, to } か { error }
function copySkill(entry, home, cwd, toTool) {
  if (!entry || !NAME.test(entry.dirName || '')) return { error: 'このスキルはフォルダ名が特殊なためコピーできません' };
  if (entry.tool === toTool) return { error: '同じツールにはコピーできません' };
  const root = destRoot(home, cwd, toTool, entry.scope);
  if (!root) return { error: 'コピー先が決まりません' };
  const to = path.join(root, entry.dirName);
  if (fs.existsSync(to)) return { error: '同じ名前のスキルがコピー先にすでにあります(上書きはしません)' };
  if (!measure(entry.dir)) return { error: '大きすぎるためコピーできません(' + LIMIT.files + 'ファイル・' + Math.round(LIMIT.bytes / 1048576) + 'MBまで)' };
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(entry.dir, to, { recursive: true, dereference: true, errorOnExist: true, force: false, filter: s => !SKIP.has(path.basename(s)) });
  } catch (e) { try { fs.rmSync(to, { recursive: true, force: true }); } catch {} return { error: 'コピーに失敗しました' }; }
  return { ok: true, to };
}

module.exports = { parseMeta, roots, scan, group, destRoot, copySkill, measure, NAME };
