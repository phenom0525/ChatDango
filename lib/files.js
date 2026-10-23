'use strict';
// 作業フォルダ内のファイル閲覧・編集(PC本体の画面からだけ使う)。フォルダの外・.git の中は触れない。
const fs = require('fs');
const path = require('path');

const MAX_READ = 1024 * 1024, MAX_WRITE = 2 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i; // Windowsの予約名(デバイスに化ける)
const HIDE = new Set(['.git', 'node_modules', '.DS_Store']);

// root の中の相対パスだけを許す。外へ出るもの・.git 配下は null
function safe(root, rel) {
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('\0')) return null;
  if (rel.split('/').some(s => s.includes(':') || (s !== '.' && s !== '..' && /[. ]$/.test(s)) || RESERVED.test(s))) return null; // NTFS代替ストリーム・末尾ドット/空白
  const f = path.resolve(root, rel), r = path.relative(root, f);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  if (r.split(path.sep).some(s => s.toLowerCase() === '.git')) return null;
  try { // シンボリックリンク等で root の外へ出るものを拒否(存在する最も近い親で判定)
    let q = f; while (!fs.existsSync(q)) { const n = path.dirname(q); if (n === q) break; q = n; }
    const rr = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(q));
    if (rr.startsWith('..') || path.isAbsolute(rr)) return null;
    if (rr.split(path.sep).some(s => s.toLowerCase() === '.git')) return null; // リンク経由で .git に入るのも拒否
  } catch { return null; }
  return f;
}
function list(root, rel) {
  const d = safe(root, rel); if (!d) return { error: 'この場所は開けません' };
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return { error: '読めません' }; }
  const out = ents.filter(e => !HIDE.has(e.name)).map(e => {
    let size = 0, mtime = 0; try { const s = fs.statSync(path.join(d, e.name)); size = s.size; mtime = s.mtimeMs; } catch {}
    return { name: e.name, dir: e.isDirectory(), size, mtime };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'ja'));
  return { path: path.relative(root, d).replace(/\\/g, '/'), entries: out.slice(0, 2000) };
}
function read(root, rel) {
  const f = safe(root, rel); if (!f) return { error: 'この場所は開けません' };
  let st; try { st = fs.statSync(f); } catch { return { error: 'ファイルが見つかりません' }; }
  if (!st.isFile()) return { error: 'ファイルではありません' };
  if (st.size > MAX_READ) return { error: '大きすぎて開けません(' + Math.round(st.size / 1024) + 'KB。1MBまで)', size: st.size };
  const b = fs.readFileSync(f);
  if (b.includes(0)) return { error: 'バイナリファイルは開けません', binary: true, size: st.size };
  let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return { error: 'UTF-8以外の文字コード(Shift_JISなど)は、保存すると文字化けするため開けません', binary: true, size: st.size }; }
  return { content, mtime: st.mtimeMs, size: st.size };
}
function write(root, rel, content, base) {
  const f = safe(root, rel); if (!f) return { error: 'この場所には保存できません' };
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_WRITE) return { error: '内容が大きすぎます(2MBまで)' };
  let st = null; try { st = fs.statSync(f); } catch {}
  if (st && !st.isFile()) return { error: 'ファイルではありません' };
  if (st && base && Math.abs(st.mtimeMs - base) > 1) return { error: '開いたあとに別の場所で変更されています。開き直してから保存してください', conflict: true };
  const tmp = f + '.' + require('crypto').randomBytes(6).toString('hex') + '.vc-tmp'; // 推測できない名前+排他作成(既存リンクへの書き込みを防ぐ)
  try { fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} return { error: '保存に失敗しました' }; }
  return { ok: true, mtime: fs.statSync(f).mtimeMs };
}
module.exports = { safe, list, read, write };

// プロジェクト統計: ファイル数・行数・種類の内訳・大きいファイル・最近変わったファイル
const SKIP_DIR = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache', 'vendor']);
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'md', 'txt', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'xml', 'sql', 'vue', 'svelte', 'lua', 'swift', 'ini', 'cfg']);
function stats(root) {
  const MAX_FILES = 20000, t0 = Date.now();
  const byExt = {}, all = []; let files = 0, lines = 0, bytes = 0, cut = false;
  const walk = (d, depth) => {
    if (cut || depth > 12) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (cut) return;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1); continue; }
      if (!e.isFile()) continue;
      if (++files > MAX_FILES || Date.now() - t0 > 8000) { cut = true; return; }
      const f = path.join(d, e.name); let st; try { st = fs.statSync(f); } catch { continue; }
      const ext = (path.extname(e.name).slice(1) || '(なし)').toLowerCase();
      let n = 0;
      if (TEXT_EXT.has(ext) && st.size <= 2 * 1024 * 1024) { try { const b = fs.readFileSync(f); for (let i = 0; i < b.length; i++) if (b[i] === 10) n++; if (b.length && b[b.length - 1] !== 10) n++; } catch {} }
      const x = byExt[ext] || (byExt[ext] = { ext, files: 0, lines: 0, bytes: 0 });
      x.files++; x.lines += n; x.bytes += st.size; lines += n; bytes += st.size;
      all.push({ path: path.relative(root, f).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(root, 0);
  return {
    files: Math.min(files, MAX_FILES), lines, bytes, cut,
    types: Object.values(byExt).sort((a, b) => (b.lines - a.lines) || (b.files - a.files)).slice(0, 15),
    largest: all.slice().sort((a, b) => b.size - a.size).slice(0, 10),
    recent: all.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 10),
  };
}
module.exports.stats = stats;
