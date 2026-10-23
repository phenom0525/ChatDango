'use strict';
// チェックポイント: AIに依頼を送る直前に、作業フォルダの状態を git の中へ記録し、あとでその状態へ戻せるようにする。
// 方針: 一時的な索引(インデックス)だけを使い、利用者のブランチ・コミット履歴・ステージ状態には触れない。
//       記録は refs/chatdango/<会話>/<送信> に置く(git gc で消えない。push もされない)。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT = 20000; // これを超えるほど重いフォルダでは記録を諦める(送信は止めない)
const NAME = ['-c', 'user.name=ChatDango', '-c', 'user.email=chatdango@localhost', '-c', 'commit.gpgsign=false'];
// 秘密になりやすいファイルは記録に含めない(戻すときも触れない)
const EXCLUDE = [':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key', ':(exclude,glob)**/*.pfx', ':(exclude,glob)**/id_rsa*', ':(exclude,glob)**/id_ed25519*', ':(exclude,glob)**/auth.json'];

const run = (cwd, args, env, input) => new Promise(resolve => {
  const c = execFile('git', args, { cwd, windowsHide: true, timeout: TIMEOUT, maxBuffer: 64e6, env: { ...process.env, ...(env || {}) } },
    (e, so, se) => resolve({ ok: !e, out: String(so || ''), err: String(se || (e && e.message) || '').trim() }));
  if (input != null) { c.stdin.end(input); }
});

const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const unsafeRoot = p => norm(p) === norm(os.homedir()) || norm(p) === norm(path.parse(path.resolve(p)).root);
const safeKey = k => String(k).replace(/[^\w.-]/g, '_').slice(0, 80);

// リポジトリの最上位(なければ null。ホーム/ドライブ直下は事故のもとなので対象外)
async function top(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const r = await run(cwd, ['rev-parse', '--show-toplevel']);
  const t = r.ok ? path.normalize(r.out.trim()) : '';
  return t && !unsafeRoot(t) ? t : null;
}

// 本物の索引をコピーした一時索引を作る(コピーなので速く、本物は変わらない)
async function tmpIndex(t) {
  const r = await run(t, ['rev-parse', '--git-path', 'index']);
  const real = path.resolve(t, r.out.trim() || '.git/index');
  const tmp = path.join(os.tmpdir(), 'chatdango-idx-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  try { fs.copyFileSync(real, tmp); } catch {}
  return tmp;
}
const rmQuiet = f => { try { fs.rmSync(f, { force: true }); } catch {} };

// いまの作業フォルダ全体(未追跡を含み、.gitignore と秘密ファイルを除く)をツリーにする。 { env, tree }
async function snapTree(t, idx) {
  const env = { GIT_INDEX_FILE: idx };
  const a = await run(t, ['add', '-A', '--', '.', ...EXCLUDE], env);
  if (!a.ok) return { err: a.err };
  const w = await run(t, ['write-tree'], env);
  const tree = w.out.trim();
  return w.ok && /^[0-9a-f]{40,64}$/.test(tree) ? { tree } : { err: w.err || 'write-tree失敗' };
}

// 記録する。成功なら { commit, files }、できなければ { skip: 理由 }
// label(依頼文の冒頭)は受け取るが、コミットメッセージには書かない。メールアドレスなどの入力が、リポジトリの記録に残らないようにするため
async function take(cwd, key, _label) {
  const t = await top(cwd);
  if (!t) return { skip: 'git管理外' };
  const idx = await tmpIndex(t);
  try {
    const s = await snapTree(t, idx);
    if (!s.tree) return { skip: s.err || '記録できません' };
    const head = await run(t, ['rev-parse', '--verify', '-q', 'HEAD']);
    const args = [...NAME, 'commit-tree', s.tree, ...(head.ok ? ['-p', head.out.trim()] : []), '-m', 'ChatDango checkpoint'];
    const c = await run(t, args);
    const commit = c.out.trim();
    if (!c.ok || !commit) return { skip: c.err || 'commit-tree失敗' };
    const u = await run(t, ['update-ref', 'refs/chatdango/' + safeKey(key), commit]);
    return u.ok ? { commit, top: t } : { skip: u.err };
  } finally { rmQuiet(idx); }
}

// 記録が残っているか
async function exists(cwd, commit) {
  const t = await top(cwd);
  if (!t || !/^[0-9a-f]{40,64}$/.test(commit || '')) return false;
  return (await run(t, ['cat-file', '-e', commit + '^{commit}'])).ok;
}

// 戻したときに何が変わるかの一覧(確認画面用)。{ restore:[...], remove:[...] }
async function preview(cwd, commit) {
  const t = await top(cwd);
  if (!t) return { error: 'gitのフォルダではありません' };
  if (!(await exists(t, commit))) return { error: '記録が見つかりません(削除されたか、別のフォルダです)' };
  const idx = await tmpIndex(t);
  try {
    const now = await snapTree(t, idx);
    if (!now.tree) return { error: now.err };
    return { top: t, ...(await diff(t, now.tree, commit)) };
  } finally { rmQuiet(idx); }
}

// 現在のツリー → 記録のツリーで、戻すために必要な操作を数える
async function diff(t, nowTree, commit) {
  const d = await run(t, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', nowTree, commit + '^{tree}']);
  if (!d.ok) return { error: d.err };
  const parts = d.out.split('\0').filter(x => x !== ''), restore = [], remove = [];
  for (let i = 0; i + 1 < parts.length; i += 2) { (parts[i][0] === 'D' ? remove : restore).push(parts[i + 1]); }
  return { restore, remove };
}

// 戻す。直前に「戻す前の状態」も記録するので、戻しすぎてもやり直せる。成功なら { restored, removed, undo }
async function restore(cwd, commit, key) {
  const t = await top(cwd);
  if (!t) return { error: 'gitのフォルダではありません' };
  if (!(await exists(t, commit))) return { error: '記録が見つかりません' };
  const undo = await take(t, key + '-undo-' + Date.now(), '戻す前の状態');
  if (!undo.commit) return { error: '戻す前の状態を記録できないため、中止しました(' + (undo.skip || '') + ')' };
  const idx = await tmpIndex(t);
  try {
    const now = await snapTree(t, idx);
    if (!now.tree) return { error: now.err };
    const df = await diff(t, now.tree, commit);
    if (df.error) return { error: df.error };
    const inside = p => { const f = path.resolve(t, p); return f.startsWith(path.resolve(t) + path.sep) && !/^\.git([\\/]|$)/i.test(p) ? f : null; };
    let removed = 0;
    for (const p of df.remove) { const f = inside(p); if (f) { try { fs.rmSync(f, { force: true }); removed++; } catch {} } }
    const files = df.restore.filter(inside);
    for (let i = 0; i < files.length; i += 100) { // 一時索引を通して書き戻す(本物の索引は触らない)
      const r = await run(t, ['checkout', commit, '--', ...files.slice(i, i + 100)], { GIT_INDEX_FILE: idx, GIT_LITERAL_PATHSPECS: '1' });
      if (!r.ok) return { error: '戻せないファイルがありました: ' + r.err, undo: undo.commit };
    }
    // 消したファイルがステージ済みだった場合に備えて、本物の索引からも外す
    for (let i = 0; i < df.remove.length; i += 100) await run(t, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...df.remove.slice(i, i + 100)], { GIT_LITERAL_PATHSPECS: '1' });
    return { restored: files.length, removed, undo: undo.commit };
  } finally { rmQuiet(idx); }
}

// 会話を消すとき、その会話の記録を片付ける
async function drop(cwd, keyPrefix) {
  const t = await top(cwd);
  if (!t) return 0;
  const r = await run(t, ['for-each-ref', '--format=%(refname)', 'refs/chatdango/' + safeKey(keyPrefix) + '*']);
  const names = r.out.split(/\r?\n/).filter(Boolean);
  for (const n of names) await run(t, ['update-ref', '-d', n]);
  return names.length;
}

// 古い記録を減らす(1会話あたり max 件を残す)。戻す前の記録(-undo-)も数に含める
async function prune(cwd, keyPrefix, max) {
  const t = await top(cwd);
  if (!t) return 0;
  const r = await run(t, ['for-each-ref', '--sort=committerdate', '--format=%(refname)', 'refs/chatdango/' + safeKey(keyPrefix) + '*']);
  const names = r.out.split(/\r?\n/).filter(Boolean), extra = names.slice(0, Math.max(0, names.length - max));
  for (const n of extra) await run(t, ['update-ref', '-d', n]);
  return extra.length;
}

module.exports = { top, take, exists, preview, restore, drop, prune, safeKey };
