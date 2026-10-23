// GitHub連携(会話のフォルダ単位)。git / gh CLI を呼ぶだけ。
// 方針: 作成は必ず --private。作成直後とプッシュのたびに GitHub 側の公開状態を確認し、PRIVATE と確認できなければ中止(確認できない場合も中止)。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args, cwd) => new Promise(resolve => {
  execFile(cmd, args, { cwd, windowsHide: true, timeout: 90000, maxBuffer: 8e6, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }, (e, so, se) =>
    resolve({ ok: !e, out: String(so || '').trim(), err: String(se || (e && e.message) || '').trim() }));
});
const git = (cwd, ...a) => run('git', a, cwd);
const gitRaw = (cwd, ...a) => new Promise(resolve => execFile('git', a, { cwd, windowsHide: true, timeout: 90000, maxBuffer: 8e6, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } }, (e, so) => resolve(String(so || ''))));
const gh = (cwd, ...a) => run('gh', a, cwd);

const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
// ホームフォルダやドライブ直下をリポジトリにするのは事故のもと(丸ごと送ってしまう)ので禁止
const unsafeRoot = p => { const r = path.resolve(p); return norm(r) === norm(os.homedir()) || norm(r) === norm(path.parse(r).root); };

const SECRET = /(^|\/)(\.env(\..*)?|auth\.json|[^/]*\.(pem|key|pfx|p12)|id_rsa[^/]*|id_ed25519[^/]*|credentials[^/]*|[^/]*secret[^/]*\.json|[^/]*token[^/]*\.json)$/i;
const MAX_FILE = 50 * 1024 * 1024;
const IGNORE_DEFAULT = ['node_modules/', '.env', '.env.*', '*.pem', '*.key', '*.pfx', 'id_rsa*', '__pycache__/', '*.log', '.DS_Store'];

async function top(cwd) {
  const r = await git(cwd, 'rev-parse', '--show-toplevel');
  return r.ok ? path.normalize(r.out) : '';
}
const visCache = new Map(); // top -> {t, v}
async function visibility(cwd, fresh) {
  const k = norm(cwd), c = visCache.get(k);
  if (!fresh && c && Date.now() - c.t < 60000) return c.v;
  const r = await gh(cwd, 'repo', 'view', '--json', 'visibility', '-q', '.visibility');
  const v = r.ok ? r.out.trim().toUpperCase() : '';
  visCache.set(k, { t: Date.now(), v });
  return v;
}
async function ensureIdentity(cwd) {
  const u = await gh(cwd, 'api', 'user', '--jq', '.id,.login');
  const [id, login] = u.out.split(/\r?\n/);
  if (!u.ok || !id || !login) return false;
  if (!(await git(cwd, 'config', 'user.name')).out.trim()) await git(cwd, 'config', 'user.name', login); // 設定済みの名前は書き換えない
  if (!(await git(cwd, 'config', 'user.email')).out.trim()) await git(cwd, 'config', 'user.email', id + '+' + login + '@users.noreply.github.com');
  return true;
}
function ensureIgnore(dir) {
  const f = path.join(dir, '.gitignore');
  let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch {}
  const have = new Set(cur.split(/\r?\n/).map(l => l.trim()));
  const add = IGNORE_DEFAULT.slice();
  if (fs.existsSync(path.join(dir, 'data', 'auth.json'))) add.push('data/'); // chat-cmd自身: 合言葉・会話履歴・画像を含むdata/は上げない
  const need = add.filter(l => !have.has(l));
  if (need.length) fs.writeFileSync(f, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + need.join('\n') + '\n');
}

async function status(cwd) {
  const t = await top(cwd);
  if (!t) return { repo: false, unsafe: unsafeRoot(cwd) };
  if (unsafeRoot(t)) return { repo: true, unsafe: true, top: t };
  const [br, st, rm, ah, lg, tc] = await Promise.all([
    git(t, 'branch', '--show-current'), git(t, 'status', '--porcelain'), git(t, 'remote', 'get-url', 'origin'),
    git(t, 'rev-list', '--count', '@{u}..HEAD'), git(t, 'log', '-1', '--format=%s'), git(t, 'rev-list', '--count', 'HEAD'),
  ]);
  const remote = rm.ok ? rm.out : '';
  return {
    repo: true, top: t, branch: br.out, changed: st.out ? st.out.split(/\r?\n/).length : 0, remote,
    ahead: ah.ok ? parseInt(ah.out, 10) || 0 : (remote ? null : 0), last: lg.out, total: tc.ok ? parseInt(tc.out, 10) || 0 : 0,
    visibility: remote ? await visibility(t) : '',
  };
}

async function commit(cwd, message) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t)) return { ok: false, error: 'このフォルダはリポジトリにできません(ホームやドライブ直下は禁止)。プロジェクトのフォルダを作業フォルダにしてください' };
  if (!(await ensureIdentity(t))) return { ok: false, error: 'GitHubのログイン情報を取得できません(gh auth status を確認)' };
  ensureIgnore(t);
  await git(t, 'add', '-A');
  const names = (await git(t, 'diff', '--cached', '--name-only')).out.split(/\r?\n/).filter(Boolean);
  if (!names.length) return { ok: true, message: '変更はありません' };
  const bad = names.filter(n => SECRET.test(n));
  const big = names.filter(n => { try { return fs.statSync(path.join(t, n)).size > MAX_FILE; } catch { return false; } });
  if (bad.length || big.length) {
    await git(t, 'reset', '-q');
    return { ok: false, error: (bad.length ? '秘密情報らしいファイルが含まれるため中止しました: ' + bad.slice(0, 5).join(', ') + '\n(.gitignore に追加してからやり直してください)\n' : '') + (big.length ? '50MBを超えるファイルがあるため中止しました: ' + big.slice(0, 5).join(', ') : '') };
  }
  const msg = (message || '').trim() || ('更新 ' + new Date().toLocaleString('ja-JP'));
  const r = await git(t, 'commit', '-m', msg);
  return r.ok ? { ok: true, message: 'コミットしました(' + names.length + 'ファイル)' } : { ok: false, error: r.err || r.out };
}

async function push(cwd) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t)) return { ok: false, error: 'このフォルダからはプッシュできません' };
  const rm = await git(t, 'remote', 'get-url', 'origin');
  if (!rm.ok) return { ok: false, error: 'GitHubのリポジトリが未作成です。先に「非公開リポジトリを作成」を押してください' };
  const v = await visibility(t, true);
  if (v !== 'PRIVATE') return { ok: false, error: v ? 'このリポジトリは「非公開」ではない(' + v + ')ためプッシュを中止しました。GitHubで非公開に変更してください' : 'GitHub側の公開状態を確認できないため、安全のためプッシュを中止しました' };
  const r = await git(t, 'push', '-u', 'origin', 'HEAD');
  return r.ok ? { ok: true, message: 'プッシュしました(非公開リポジトリ)' } : { ok: false, error: r.err || r.out };
}

async function createPrivate(cwd, name) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name || '')) return { ok: false, error: 'リポジトリ名は英数字と . _ - のみ(80字まで)にしてください' };
  let t = await top(cwd);
  if (t && unsafeRoot(t)) return { ok: false, error: 'このフォルダはリポジトリにできません(ホームやドライブ直下は禁止)。プロジェクトのフォルダを作業フォルダにしてください' };
  if (!t && unsafeRoot(cwd)) return { ok: false, error: 'このフォルダはリポジトリにできません(ホームやドライブ直下は禁止)。プロジェクトのフォルダを作業フォルダにしてください' };
  if (t && (await git(t, 'remote', 'get-url', 'origin')).ok) return { ok: false, error: 'すでにGitHubと紐づいています' };
  if (!t) { const i = await git(cwd, 'init', '-b', 'main'); if (!i.ok) return { ok: false, error: i.err }; t = cwd; }
  const c = await commit(t, '最初のコミット');
  if (!c.ok) return c;
  const has = await git(t, 'rev-parse', '--verify', 'HEAD');
  if (!has.ok) return { ok: false, error: 'コミットするファイルがありません' };
  const r = await gh(t, 'repo', 'create', name, '--private', '--source', '.', '--remote', 'origin');
  if (!r.ok) return { ok: false, error: r.err || r.out };
  const v = await visibility(t, true);
  if (v !== 'PRIVATE') return { ok: false, error: '作成後の公開状態が PRIVATE と確認できませんでした(' + (v || '不明') + ')。GitHubで状態を確認してください。プッシュはしていません' };
  const p = await push(t);
  return p.ok ? { ok: true, message: '非公開リポジトリ「' + name + '」を作成してプッシュしました' } : p;
}

// 変更ファイル一覧(コミットされる対象)
async function changedFiles(cwd) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t)) return { ok: false, error: 'このフォルダはリポジトリではありません' };
  const raw = await gitRaw(t, 'status', '--porcelain=v1', '-z', '-uall');
  const parts = raw.split('\0').filter(Boolean), files = [];
  for (let i = 0; i < parts.length; i++) {
    const x = parts[i], st = x.slice(0, 2), name = x.slice(3);
    if (st[0] === 'R' || st[0] === 'C') i++; // 元の名前は読み飛ばす
    files.push({ path: name, st: st.trim() || '?', secret: SECRET.test(name) });
  }
  return { ok: true, top: t, files: files.slice(0, 500), more: files.length > 500 };
}
// 1ファイルの差分(読めるだけ。表示用に200KBで切る)
async function fileDiff(cwd, rel) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t) || typeof rel !== 'string' || !rel) return { ok: false, error: '対象を開けません' };
  const abs = path.resolve(t, rel), r0 = path.relative(t, abs);
  if (r0.startsWith('..') || path.isAbsolute(r0) || r0.split(path.sep).some(s => s.toLowerCase() === '.git')) return { ok: false, error: '対象を開けません' };
  try { const rr = path.relative(fs.realpathSync(t), fs.realpathSync(abs)); if (rr.startsWith('..') || path.isAbsolute(rr) || rr.split(path.sep).some(s => s.toLowerCase() === '.git')) return { ok: false, error: '対象を開けません' }; } catch {}
  if (SECRET.test(rel.replace(/\\/g, '/'))) return { ok: true, diff: '(秘密情報らしいファイルなので内容は表示しません)', secret: true };
  const tracked = (await git(t, 'ls-files', '--error-unmatch', '--', rel)).ok;
  let out;
  if (tracked) out = (await git(t, 'diff', 'HEAD', '--no-color', '--', rel)).out;
  else {
    let txt; try { if (fs.statSync(abs).size > 2 * 1024 * 1024) return { ok: true, diff: '(大きいファイルなので表示しません)' }; const b = fs.readFileSync(abs); if (b.includes(0)) return { ok: true, diff: '(バイナリファイル)' }; txt = b.toString('utf8'); } catch { return { ok: false, error: '読めません' }; }
    const lines = txt.split('\n'); out = '新規ファイル: ' + rel + '\n@@ -0,0 +1,' + lines.length + ' @@\n' + lines.map(l => '+' + l.replace(/\r$/, '')).join('\n');
  }
  const cut = out.length > 200000;
  return { ok: true, diff: cut ? out.slice(0, 200000) + '\n…(長いので途中まで)' : out };
}

// ---- GitHub Issues ボード(未着手 / 進行中 / 完了)。進行中は in-progress ラベルで表す ----
const DOING = 'in-progress';
async function issueList(cwd) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t)) return { ok: false, error: 'このフォルダはリポジトリではありません' };
  if (!(await git(t, 'remote', 'get-url', 'origin')).ok) return { ok: false, error: 'GitHubと未接続です。先に「非公開リポジトリを作成」してください' };
  const r = await gh(t, 'issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels,url,assignees,updatedAt');
  if (!r.ok) return { ok: false, error: r.err || 'Issueを取得できません(ghのログイン・リポジトリのIssue設定を確認)' };
  let arr; try { arr = JSON.parse(r.out || '[]'); } catch { return { ok: false, error: '取得結果を読めません' }; }
  const cards = arr.map(i => ({ number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt, labels: (i.labels || []).map(l => l.name).filter(n => n !== DOING), who: (i.assignees || []).map(a => a.login), col: i.state === 'CLOSED' ? 'done' : (i.labels || []).some(l => l.name === DOING) ? 'doing' : 'todo' }));
  return { ok: true, cards };
}
// 書き込み(作成・移動)は、プッシュと同じく「非公開」と確認できたときだけ
async function issueWritable(cwd) {
  const t = await top(cwd);
  if (!t || unsafeRoot(t)) return { error: 'このフォルダはリポジトリではありません' };
  const v = await visibility(t, true);
  if (v !== 'PRIVATE') return { error: v ? 'このリポジトリは「非公開」ではない(' + v + ')ため、Issueの変更は中止しました' : 'GitHub側の公開状態を確認できないため、Issueの変更は中止しました' };
  return { t };
}
async function issueMove(cwd, number, col) {
  const w = await issueWritable(cwd); if (w.error) return { ok: false, error: w.error };
  const n = String(parseInt(number, 10)); if (!/^[1-9]\d*$/.test(n)) return { ok: false, error: '番号が不正です' };
  const t = w.t;
  if (col === 'done') { const r = await gh(t, 'issue', 'close', n); if (!r.ok) return { ok: false, error: r.err }; await gh(t, 'issue', 'edit', n, '--remove-label', DOING); return { ok: true }; }
  if (col !== 'todo' && col !== 'doing') return { ok: false, error: '移動先が不正です' };
  await gh(t, 'issue', 'reopen', n); // 開いていれば何も起きない
  if (col === 'doing') { await gh(t, 'label', 'create', DOING, '--color', 'fbca04', '--force'); const r = await gh(t, 'issue', 'edit', n, '--add-label', DOING); return r.ok ? { ok: true } : { ok: false, error: r.err }; }
  const r = await gh(t, 'issue', 'edit', n, '--remove-label', DOING); return r.ok ? { ok: true } : { ok: false, error: r.err };
}
async function issueCreate(cwd, title, body) {
  title = String(title || '').trim().slice(0, 200); if (!title) return { ok: false, error: 'タイトルが空です' };
  const w = await issueWritable(cwd); if (w.error) return { ok: false, error: w.error };
  const r = await gh(w.t, 'issue', 'create', '--title', title, '--body', String(body || '').slice(0, 20000));
  return r.ok ? { ok: true, message: 'Issueを作成しました' } : { ok: false, error: r.err || r.out };
}

async function handle(method, cwd, b) {
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: '作業フォルダが見つかりません' };
  if (method === 'GET') return { ok: true, ...(await status(cwd)) };
  switch (b.action) {
    case 'commit': return commit(cwd, b.message);
    case 'push': return push(cwd);
    case 'commit-push': { const c = await commit(cwd, b.message); if (!c.ok) return c; const p = await push(cwd); return p.ok ? { ok: true, message: c.message + ' → ' + p.message } : p; }
    case 'create': return createPrivate(cwd, b.name);
    case 'files': return changedFiles(cwd);
    case 'issues': return issueList(cwd);
    case 'issue-move': return issueMove(cwd, b.number, b.col);
    case 'issue-create': return issueCreate(cwd, b.title, b.body);
    case 'diff': return fileDiff(cwd, b.path);
    default: return { ok: false, error: '不明な操作' };
  }
}
module.exports = { handle, unsafeRoot };
