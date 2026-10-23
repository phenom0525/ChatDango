'use strict';
// yomiyasu の更新: GitHub の公式リリース(nanaism/yomiyasu)の最新版を data/yomiyasu-latest に取り込む。
// 取り込むのは「設定の更新ボタンを押したとき」だけ。自動では実行しない。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = 'nanaism/yomiyasu';
const MAX_ZIP = 20 * 1024 * 1024, MAX_FILES = 500, MAX_UNPACKED = 60 * 1024 * 1024;

// 'v2.0.1' / '2.0.1' → [2,0,1]。読めなければ null
function parseVer(v) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b); if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
// SKILL.md の frontmatter から version を読む
function versionOf(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = /^\s*version:\s*"?([0-9.]+)"?\s*$/m.exec(t.split('---')[1] || '');
    return m ? m[1] : '';
  } catch { return ''; }
}

// zip(Buffer)を dest に展開する。依存なし。パスの外し・容量・ファイル数を検査。先頭1階層(リポジトリ名-タグ/)は取り除く
function unzipTo(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zipが壊れています');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (n > MAX_FILES) throw new Error('ファイル数が多すぎます');
  const ents = []; let total = 0;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zipが壊れています');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/');
    p += 46 + nl + el + cl; total += usize;
    if (total > MAX_UNPACKED) throw new Error('展開後が大きすぎます');
    ents.push({ name, method, csize, usize, off });
  }
  const top = new Set(ents.map(e => e.name.split('/')[0]));
  const strip = top.size === 1 && ents.every(e => e.name.includes('/')) ? 1 : 0;
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest); let written = 0;
  for (const e of ents) {
    const parts = e.name.split('/').slice(strip).filter(Boolean);
    if (!parts.length) continue;
    if (parts.some(s => s === '..' || s.includes(':') || s.includes('\0'))) throw new Error('不正なパスが含まれています');
    const out = path.resolve(root, ...parts);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error('不正なパスが含まれています');
    if (e.name.endsWith('/')) { fs.mkdirSync(out, { recursive: true }); continue; }
    const ho = e.off; if (buf.readUInt32LE(ho) !== 0x04034b50) throw new Error('zipが壊れています');
    const ds = ho + 30 + buf.readUInt16LE(ho + 26) + buf.readUInt16LE(ho + 28);
    const raw = buf.subarray(ds, ds + e.csize);
    const data = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED }) : null;
    if (!data) throw new Error('未対応の圧縮方式です');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    written += data.length; if (written > MAX_UNPACKED) throw new Error('展開後が大きすぎます');
    fs.writeFileSync(out, data);
  }
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ChatDango', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('GitHubに接続できませんでした(' + r.status + ')');
  return r.json();
}
// 最新リリースのタグ名。例: 'v2.0.1'
async function latestTag() {
  const j = await getJson('https://api.github.com/repos/' + REPO + '/releases/latest');
  if (!parseVer(j.tag_name)) throw new Error('最新版の番号を読めませんでした');
  return j.tag_name;
}
// tag のリリースを destDir に取り込む。展開は一時フォルダで行い、SKILL.md を確認できたものだけ入れ替える
let busy = false;
async function fetchRelease(tag, destDir) {
  if (!parseVer(tag)) throw new Error('版の指定が不正です');
  const r = await fetch('https://github.com/' + REPO + '/releases/download/' + tag + '/yomiyasu.zip', { headers: { 'User-Agent': 'ChatDango' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('ダウンロードに失敗しました(' + r.status + ')');
  if (+r.headers.get('content-length') > MAX_ZIP) throw new Error('ファイルが大きすぎます');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_ZIP) throw new Error('ファイルが大きすぎます');
  if (busy) throw new Error('更新中です。しばらく待ってからやり直してください');
  busy = true;
  const tmp = destDir + '.tmp', old = destDir + '.old';
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    unzipTo(buf, tmp);
    if (!fs.existsSync(path.join(tmp, 'SKILL.md')) || !fs.existsSync(path.join(tmp, 'LICENSE'))) throw new Error('yomiyasuのスキルとして読めませんでした');
    if (cmpVer(versionOf(tmp), tag) !== 0) throw new Error('版の番号が一致しません');
    fs.writeFileSync(path.join(tmp, 'VENDORED.txt'), 'yomiyasu ' + tag + ' (https://github.com/' + REPO + '/releases/tag/' + tag + ')\nMIT License / nanaism\nChatDangoの更新機能で取り込みました。\n');
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(destDir)) fs.renameSync(destDir, old);
    try { fs.renameSync(tmp, destDir); } catch (e) { if (fs.existsSync(old)) fs.renameSync(old, destDir); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  finally { busy = false; }
}

module.exports = { REPO, parseVer, cmpVer, versionOf, unzipTo, latestTag, fetchRelease };
