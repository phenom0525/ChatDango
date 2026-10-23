'use strict';
// AI接続の管理: 登録(connections.json) / APIキー(Windows DPAPIで暗号化) / 共通アダプター(CLI・OpenAI互換API) / エラー分類
// アダプター共通のイベント: session / text / delta / tool / usage / error / done(下の run() のコールバック)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const OK_ARG = /^[\w.:\/\\@=+\-]{1,200}$/;   // CLIへ渡す引数(空白・引用符・&|<>^% は通さない: shell文字列を作らない)
const OK_EXE = /^[\w.:\/\\ ()\-]{1,260}$/;
const OK_URL = /^https?:\/\/[^\s"'<>`^|&]{1,200}$/;
const OK_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
const OK_MODEL = /^[\w.:\/@+\-]{1,100}$/;
const COSTS = ['free', 'paid', 'limited', 'unknown'];
const COST_LABEL = { free: '無料', paid: '有料', limited: '期間限定無料', unknown: '不明' };
const KINDS = ['cli', 'api'];

const CAPS_API = { chat: true, image: false, files: false, exec: false, resume: false, approval: false, stream: true, stop: true };
// 能力はUIの表示/非表示に使う。確認できていないものは false(出さない)
const PRESETS = {
  opencode: { label: 'OpenCode', kind: 'cli', provider: 'opencode', exe: 'opencode', caps: { chat: true, image: false, files: true, exec: true, resume: true, approval: false, stream: false, stop: true },
    note: '公式CLIの `opencode run --format json` を使います。ログインは `opencode auth login` を自分のターミナルで。権限は OpenCode 側の設定に従います(このアプリは緩めません)。無料モデルは「モデル一覧を取得」で出てくるものだけを使えます。' },
  gemini: { label: 'Gemini CLI', kind: 'cli', provider: 'gemini', exe: 'gemini', caps: { chat: true, image: false, files: true, exec: true, resume: false, approval: false, stream: false, stop: true },
    note: '公式CLIの `gemini -p --output-format stream-json`(ヘッドレス)を使います。ログインは自分のターミナルで `gemini` を一度起動して行ってください。会話の記憶は引き継ぎ文で補います(再開機能は使いません)。モデル一覧の取得手段がないため、必要なら手で追加します。' },
  deepseek: { label: 'DeepSeek API', kind: 'api', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', caps: CAPS_API,
    models: [{ id: 'deepseek-v4-flash', cost: 'paid', note: '従量課金のAPI(価格は公式で要確認・未取得)' }, { id: 'deepseek-v4-pro', cost: 'paid', note: '従量課金のAPI(価格は公式で要確認・未取得)' }],
    costInfo: { checkedAt: '2026-10-16', source: 'https://api-docs.deepseek.com/' },
    note: '会話のみ(ファイル編集やコマンド実行はできません)。APIキーは DeepSeek の公式サイトで発行します。' },
  zai: { label: 'Z.ai API', kind: 'api', provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', caps: CAPS_API,
    models: [{ id: 'glm-4.7-flash', cost: 'unknown', note: '第三者の記事では無料(速度制限あり)と書かれていますが、公式では未確認' }, { id: 'glm-4.5-flash', cost: 'unknown', note: '第三者の記事では無料(速度制限あり)と書かれていますが、公式では未確認' }],
    costInfo: { checkedAt: '2026-10-16', source: '(公式ページ未確認・第三者記事のみ)' },
    note: '会話のみ。Z.ai の公式サイトでAPIキーを発行します。URLは中国向け(open.bigmodel.cn)と別なので注意。' },
  openai: { label: 'OpenAI互換API', kind: 'api', provider: 'openai', baseUrl: '', caps: CAPS_API, models: [],
    note: 'OpenAI互換の /chat/completions に話しかけます。自分のPC上のサーバー等でキーが要らない場合は、キーなしで使えます。' },
};

const mkErr = (code, msg, hint) => Object.assign(new Error(msg), { info: { code, msg, hint: hint || '' } });
const redact = (t, key) => { t = String(t == null ? '' : t); if (key && key.length > 5) t = t.split(key).join('***'); return t.replace(/\b(sk|key|tok|Bearer)[-_ ]?[A-Za-z0-9._-]{16,}/g, '$1-***'); };

// 失敗の分類: 画面に「何が原因か」と「どうすればいいか」を出す
function classify(text, status, kind) {
  const t = String(text || '');
  const E = (code, msg, hint) => ({ code, msg, hint });
  if (!status && /is not recognized|ENOENT|not found|command not found|見つかりません|認識されていません/i.test(t) && kind === 'cli') return E('cli_missing', 'CLIが見つかりません', 'インストールされているか、設定の「実行ファイル」が合っているか確認してください(PowerShellで `<コマンド> --version` が動けばOK)');
  if (status === 402 || /insufficient.{0,20}(balance|funds|quota)|balance|billing|payment required|credit/i.test(t)) return E('balance', '残高または利用枠が足りません', '提供元のサイトで残高/プランを確認してください(無料枠から有料へ自動では切り替えません)');
  if (status === 429 || /rate.?limit|too many requests|free.{0,20}(tier|usage|limit)|usage limit|quota/i.test(t)) return E('rate', '利用回数の上限(レート制限・無料枠)に達しました', '少し待ってから再試行するか、上限が緩い別の接続/モデルを選んでください');
  if (status === 401 || status === 403 || /invalid.{0,20}api.?key|incorrect api key|unauthorized|authentication|forbidden/i.test(t)) return kind === 'cli'
    ? E('login', 'ログインが必要か、認証に失敗しました', '公式の手順で自分のターミナルからログインし直してください(このアプリはログイン情報を扱いません)')
    : E('bad_key', 'APIキーが無効か、権限がありません', '設定 → AI接続 でキーを入れ直してください');
  if (/not logged in|log ?in required|please (log|sign) ?in|no credentials|login|oauth/i.test(t) && kind === 'cli') return E('login', 'ログインが必要です', '公式の手順で自分のターミナルからログインしてください');
  if (status === 404 || /model.{0,40}(not found|does not exist|deprecated|retired|unsupported|not supported)|unknown model|invalid model/i.test(t)) return E('model', 'モデルが見つかりません(終了・名前変更の可能性)', '設定 → AI接続 で「モデル一覧を取得」し直して、別のモデルを選んでください');
  if (kind === 'cli' && /unexpected server error/i.test(t)) return E('model', 'モデルが終了したか、提供元のサーバーエラーです', '設定 → AI接続 で「モデル一覧を取得」し直して、別のモデルを選んでください。直らないときは時間をおいてください');
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket hang up|terminated/i.test(t)) return E('network', '通信できません', 'ネット接続とURLを確認してください。会話の履歴と入力は残っています');
  if (status === 400 || status === 422) return E('unsupported', 'この接続では対応していない指定です', '詳細: ' + t.slice(0, 200));
  return E('other', 'エラー', t.trim().slice(-300));
}

// ---- APIキーの暗号保存(Windows DPAPI: このPCのこのユーザーでしか復号できない) ----
function dpapi(mode, input) {
  if (process.platform !== 'win32') throw mkErr('unsupported', 'この環境ではキーを安全に保存できません', '環境変数名を指定する方法を使ってください');
  const enc = '$s=[Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString';
  const dec = '$s=[Console]::In.ReadToEnd().Trim(); $q=ConvertTo-SecureString $s; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($q); try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}';
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mode === 'enc' ? enc : dec], { input, encoding: 'utf8', windowsHide: true, timeout: 20000 }).replace(/\r?\n$/, ''); }
  catch { throw mkErr('other', 'キーの暗号化/復号に失敗しました', 'キーを入れ直してください'); }
}

// ---- 登録の保存 ----
function createStore(dir) {
  const F = path.join(dir, 'connections.json'), SF = path.join(dir, 'secrets.json');
  let data = { list: [], defaultId: '' }, secrets = {};
  try { const j = JSON.parse(fs.readFileSync(F, 'utf8')); data = { list: Array.isArray(j.list) ? j.list : [], defaultId: j.defaultId || '' }; } catch {}
  try { secrets = JSON.parse(fs.readFileSync(SF, 'utf8')); } catch {}
  const keyCache = new Map(), status = new Map();
  const wr = (f, o) => { fs.mkdirSync(dir, { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
  const save = () => wr(F, data), saveS = () => wr(SF, secrets);
  const get = id => data.list.find(c => c.id === id);

  function clean(b, old) {
    const o = { ...(old || {}) };
    if (!old) { o.id = 'c_' + require('crypto').randomBytes(5).toString('hex'); if (!KINDS.includes(b.kind)) throw mkErr('other', '種類が不正です'); o.kind = b.kind; o.provider = String(b.provider || (b.kind === 'api' ? 'openai' : 'custom')).replace(/[^\w-]/g, '').slice(0, 20); }
    const pr = PRESETS[o.provider];
    if (b.name !== undefined) o.name = String(b.name).trim().slice(0, 40) || (pr ? pr.label : '接続');
    o.name = o.name || (pr ? pr.label : '接続');
    if (b.enabled !== undefined) o.enabled = !!b.enabled;
    if (o.enabled === undefined) o.enabled = true;
    if (o.kind === 'api') {
      if (b.baseUrl !== undefined) { const u = String(b.baseUrl).trim().replace(/\/+$/, ''); if (u && !OK_URL.test(u)) throw mkErr('other', 'URLの形式が正しくありません'); o.baseUrl = u; }
      if (b.keyEnv !== undefined) { const k = String(b.keyEnv).trim(); if (k && !OK_ENV.test(k)) throw mkErr('other', '環境変数名の形式が正しくありません'); o.keyEnv = k; }
      o.format = 'openai';
    } else {
      if (b.exe !== undefined) { const e = String(b.exe).trim(); if (e && !OK_EXE.test(e)) throw mkErr('other', '実行ファイルの指定に使えない文字が含まれています'); o.exe = e; }
      if (b.preArgs !== undefined) { const a = (Array.isArray(b.preArgs) ? b.preArgs : String(b.preArgs).split(/\s+/)).map(x => String(x).trim()).filter(Boolean); if (a.some(x => !OK_ARG.test(x))) throw mkErr('other', '起動引数に使えない文字が含まれています(空白・引用符・& | < > ^ % は不可)'); o.preArgs = a.slice(0, 10); }
      if (b.env !== undefined && b.env && typeof b.env === 'object') { const e = {}; for (const [k, v] of Object.entries(b.env)) { if (!OK_ENV.test(k) || /^(PATH|COMSPEC|PATHEXT)$/i.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v) || v.length > 200) throw mkErr('other', '環境変数の指定が正しくありません: ' + k); e[k] = v; } o.env = e; }
    }
    if (b.models !== undefined) {
      if (!Array.isArray(b.models)) throw mkErr('other', 'モデル一覧が不正です');
      o.models = b.models.slice(0, 300).map(m => { const id = String(m.id || '').trim(); if (!OK_MODEL.test(id)) throw mkErr('other', 'モデルIDに使えない文字があります: ' + id.slice(0, 40)); return { id, label: String(m.label || '').slice(0, 60), cost: COSTS.includes(m.cost) ? m.cost : 'unknown', note: String(m.note || '').slice(0, 200), src: ['preset', 'fetched', 'manual'].includes(m.src) ? m.src : 'manual' }; });
    }
    if (b.defaultModel !== undefined) { const d = String(b.defaultModel).trim(); if (d && !OK_MODEL.test(d)) throw mkErr('other', '既定モデルの形式が正しくありません'); o.defaultModel = d; }
    o.caps = { ...(pr ? pr.caps : (o.kind === 'api' ? CAPS_API : { chat: true, resume: false, stop: true })), ...(o.caps || {}) };
    if (pr) o.caps = { ...pr.caps };
    return o;
  }
  return {
    PRESETS, COST_LABEL,
    list: () => data.list, get,
    defaultId: () => data.defaultId,
    setDefault(id) { if (id && !get(id) && id !== 'claude' && id !== 'codex') throw mkErr('other', '存在しない接続です'); data.defaultId = id || ''; save(); },
    create(b) {
      const pr = PRESETS[b.provider]; const base = pr ? { kind: pr.kind, provider: pr.provider, name: pr.label, baseUrl: pr.baseUrl, exe: pr.exe, models: (pr.models || []).map(m => ({ ...m, src: 'preset' })), costInfo: pr.costInfo } : {};
      const o = clean({ ...base, ...b, models: b.models !== undefined ? b.models : base.models });
      if (pr && pr.costInfo) o.costInfo = pr.costInfo;
      if (o.kind === 'api' && o.baseUrl === undefined) o.baseUrl = '';
      data.list.push(o); save(); return o;
    },
    update(id, b) { const old = get(id); if (!old) throw mkErr('other', '存在しない接続です'); const o = clean(b, old); data.list[data.list.indexOf(old)] = o; save(); return o; },
    remove(id) { data.list = data.list.filter(c => c.id !== id); if (data.defaultId === id) data.defaultId = ''; delete secrets[id]; keyCache.delete(id); status.delete(id); save(); saveS(); },
    setKey(id, key) { if (!get(id)) throw mkErr('other', '存在しない接続です'); key = String(key || '').trim(); if (!key) { delete secrets[id]; keyCache.delete(id); saveS(); return; } if (/[\r\n\0]/.test(key) || key.length > 400) throw mkErr('other', 'キーの形式が正しくありません'); secrets[id] = dpapi('enc', key); keyCache.set(id, key); saveS(); },
    hasKey(c) { return !!secrets[c.id] || !!(c.keyEnv && process.env[c.keyEnv]); },
    getKey(c) { if (c.keyEnv && process.env[c.keyEnv]) return process.env[c.keyEnv]; if (keyCache.has(c.id)) return keyCache.get(c.id); if (!secrets[c.id]) return ''; const k = dpapi('dec', secrets[c.id]); keyCache.set(c.id, k); return k; },
    status, save,
    // 画面へ返す形(キー・平文の秘密は含めない)
    view(c, has) { const { ...o } = c; o.hasKey = has; o.status = status.get(c.id) || null; return o; },
  };
}

// ---- 実行ファイルの解決(.cmd/.bat は cmd.exe 経由。引数は検証済みのものだけ渡す) ----
function resolveExe(exe) {
  exe = String(exe || '').trim(); if (!OK_EXE.test(exe)) return '';
  if (/[\\/]/.test(exe)) return fs.existsSync(exe) ? exe : '';
  try { return execFileSync('where', [exe], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).split(/\r?\n/).filter(Boolean).sort((a, b) => /\.(exe|cmd|bat)$/i.test(b) - /\.(exe|cmd|bat)$/i.test(a))[0] || ''; } catch { return ''; }
}
function spawnCli(file, args, opt) {
  for (const a of args) if (!OK_ARG.test(a)) throw mkErr('other', '引数に使えない文字が含まれています: ' + String(a).slice(0, 30));
  if (/\.(cmd|bat)$/i.test(file)) {
    if (/["&|<>^%!]/.test(file)) throw mkErr('other', '実行ファイルのパスに使えない文字が含まれています');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + '"' + file + '" ' + args.join(' ') + '"'], { ...opt, windowsVerbatimArguments: true, shell: false, windowsHide: true });
  }
  return spawn(file, args, { ...opt, shell: false, windowsHide: true });
}
function cliOnce(file, args, ms, env) { // 短い確認コマンド(--version / models)
  return new Promise(res => {
    let out = '', err = '', done = false;
    let c; try { c = spawnCli(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return res({ code: -1, out: '', err: e.message }); }
    const fin = r => { if (done) return; done = true; clearTimeout(t); res(r); };
    const t = setTimeout(() => { try { c.kill(); } catch {} fin({ code: -2, out, err: err || 'タイムアウト' }); }, ms || 15000);
    c.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-200000); });
    c.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    c.on('error', e => fin({ code: -1, out, err: String(e.message) }));
    c.on('close', code => fin({ code, out, err }));
  });
}

// ---- 接続テスト / モデル一覧 ----
const aborted = ms => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };
async function apiModels(conn, key) {
  if (!conn.baseUrl) throw mkErr('other', 'URLが未設定です', '設定 → AI接続 でURLを入れてください');
  const to = aborted(15000);
  let r; try { r = await fetch(conn.baseUrl + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: to.signal, redirect: 'error' }); }
  catch (e) { throw mkErr(...Object.values(classify(String(e.cause && e.cause.code || e.message), 0, 'api'))); } finally { to.done(); }
  const text = await r.text().catch(() => '');
  if (!r.ok) { const c = classify(redact(text, key), r.status, 'api'); throw mkErr(c.code, c.msg + '(HTTP ' + r.status + ')', c.hint); }
  let j; try { j = JSON.parse(text); } catch { throw mkErr('unsupported', 'モデル一覧の形式が想定と違います', 'OpenAI互換の /models に対応していない可能性があります。モデルIDは手で追加してください'); }
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return arr.map(m => typeof m === 'string' ? m : m && (m.id || m.name)).filter(id => typeof id === 'string' && OK_MODEL.test(id)).map(id => ({ id, label: '', cost: /-free$|:free$/i.test(id) ? 'free' : 'unknown', note: /-free$|:free$/i.test(id) ? '名前から推定(条件は提供元で確認)' : '', src: 'fetched' }));
}
async function cliModels(conn, env) {
  if (conn.provider !== 'opencode') throw mkErr('unsupported', 'この接続にはモデル一覧を取得する手段がありません', 'モデルIDを手で追加してください');
  const file = resolveExe(conn.exe); if (!file) throw mkErr('cli_missing', 'CLIが見つかりません', 'インストールと実行ファイルの設定を確認してください');
  const r = await cliOnce(file, [...(conn.preArgs || []), 'models'], 30000, env);
  if (r.code !== 0) { const c = classify(r.err || r.out, 0, 'cli'); throw mkErr(c.code, c.msg, c.hint); }
  const ids = [...new Set(r.out.split(/\r?\n/).map(x => x.trim()).filter(x => /^[\w.-]+\/[\w.:\/@+-]+$/.test(x)))];
  return ids.map(id => {
    if (OFFICIAL_FREE[id]) return { id, label: '', cost: 'free', note: OFFICIAL_FREE[id], src: 'fetched' };
    const free = /-free$|:free$/i.test(id);
    return { id, label: '', cost: free ? 'free' : 'unknown', note: free ? '名前から推定(提供元の条件・期間は公式で確認)' : '', src: 'fetched' };
  });
}
// 名前に -free が付かないが、提供元の公式ドキュメントで無料と書かれているもの(期間限定のことが多い)
const OFFICIAL_FREE = { 'opencode/big-pickle': 'OpenCode Zen の公式ドキュメントで無料と記載(2026-10-17確認・期間限定)' };
async function fetchModels(conn, key, env) { return conn.kind === 'api' ? apiModels(conn, key) : cliModels(conn, env); }
async function test(conn, key, env) {
  const at = Date.now();
  try {
    if (conn.kind === 'api') {
      if (!conn.baseUrl) return { status: 'failed', code: 'other', detail: 'URLが未設定です', at };
      const m = await apiModels(conn, key).catch(e => { if (e.info && e.info.code === 'unsupported') return null; throw e; });
      return { status: 'available', detail: m ? 'モデル ' + m.length + ' 件を取得できました' : '接続できました(モデル一覧は非対応)', at };
    }
    const file = resolveExe(conn.exe);
    if (!file) return { status: 'not_installed', code: 'cli_missing', detail: 'CLIが見つかりません。インストールするか、実行ファイルのパスを設定してください', at };
    const r = await cliOnce(file, [...(conn.preArgs || []), '--version'], 15000, env);
    if (r.code !== 0) { const c = classify(r.err || r.out, 0, 'cli'); return { status: 'failed', code: c.code, detail: c.msg + ': ' + c.hint + ' ' + redact(r.err, key).slice(-200), at }; }
    return { status: 'available', version: r.out.trim().split(/\r?\n/)[0].slice(0, 60), detail: '起動できました(ログイン状態は送信時に判定されます)', at };
  } catch (e) { const i = e.info || classify(e.message, 0, conn.kind); return { status: i.code === 'bad_key' || i.code === 'login' ? 'not_authenticated' : 'failed', code: i.code, detail: i.msg + (i.hint ? ': ' + i.hint : ''), at }; }
}

// ---- イベント変換(CLIの出力 → 共通イベント)。画面表示のテキストを解析せず、構造化出力だけを読む ----
const shortIn = i => { if (!i) return ''; const v = i.command || i.filePath || i.file_path || i.path || i.pattern || i.url || i.description || i.prompt || JSON.stringify(i); return String(v).replace(/\s+/g, ' ').slice(0, 140); };
function parseOpencode(ev) {
  const out = [];
  if (ev.sessionID) out.push({ t: 'session', id: ev.sessionID });
  const p = ev.part || {};
  if (ev.type === 'text' && p.text && String(p.text).trim()) out.push({ t: 'text', text: String(p.text).trim() });
  else if (ev.type === 'tool_use') out.push({ t: 'tool', text: (p.tool || 'tool') + '  ' + shortIn(p.state && p.state.input) });
  else if (ev.type === 'step_finish' && p.tokens) out.push({ t: 'usage', in: p.tokens.input || 0, out: p.tokens.output || 0 });
  else if (ev.type === 'error') { const e = ev.error || {}; out.push({ t: 'error', msg: (e.data && e.data.message) || e.message || e.name || 'エラー' }); }
  return out;
}
function parseGemini(ev, st) {
  const out = [], flush = () => { if (st.buf.trim()) out.push({ t: 'text', text: st.buf.trim() }); st.buf = ''; };
  st.buf = st.buf || '';
  const t = ev.type;
  if (t === 'init') { const id = ev.session_id || ev.sessionId; if (id) out.push({ t: 'session', id }); }
  else if (t === 'message' && ev.role === 'assistant') { const c = typeof ev.content === 'string' ? ev.content : ''; if (ev.delta) st.buf += c; else { flush(); st.buf = c; flush(); } }
  else if (t === 'tool_use') { flush(); out.push({ t: 'tool', text: (ev.tool_name || ev.name || 'tool') + '  ' + shortIn(ev.parameters || ev.args) }); }
  else if (t === 'error') out.push({ t: 'error', msg: ev.message || (ev.error && ev.error.message) || 'エラー' });
  else if (t === 'result') {
    flush(); const s = ev.stats || {}; if (s.input_tokens || s.output_tokens) out.push({ t: 'usage', in: s.input_tokens || 0, out: s.output_tokens || 0 });
    if (ev.status && ev.status !== 'success') out.push({ t: 'error', msg: (ev.error && ev.error.message) || '失敗しました' });
  }
  st.flush = flush;
  return out;
}

// ---- 実行: 接続の種類ごとの送信(共通の戻り値 {stop, done}) ----
// a: { text, model, cwd, perm, nativeId, history[{role,text}], key, env }  h: { onSession,onText,onDelta,onTool,onUsage,onError }
function run(conn, a, h) {
  if (conn.kind === 'api') return runApi(conn, a, h);
  return runCli(conn, a, h);
}
function runApi(conn, a, h) {
  const ac = new AbortController(); let stopped = false;
  const handle = { abort: () => { stopped = true; ac.abort(); }, pid: 0 };
  const done = (async () => {
    try {
      if (!conn.baseUrl) throw mkErr('other', 'URLが未設定です', '設定 → AI接続 でURLを入れてください');
      if (!a.model) throw mkErr('model', 'モデルが選ばれていません', 'チャット上部のモデル欄、または設定 → AI接続 の既定モデルを選んでください');
      const messages = [{ role: 'system', content: a.system || '' }, ...a.history].filter(m => m.content !== '' || m.role !== 'system');
      let r;
      try { r = await fetch(conn.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(a.key ? { authorization: 'Bearer ' + a.key } : {}) }, body: JSON.stringify({ model: a.model, messages, stream: true }), signal: ac.signal, redirect: 'error' }); }
      catch (e) { if (stopped) return; const c = classify(String(e.cause && e.cause.code || e.message), 0, 'api'); throw mkErr(c.code, c.msg, c.hint); }
      if (!r.ok) { const tx = await r.text().catch(() => ''); const c = classify(redact(tx, a.key), r.status, 'api'); throw mkErr(c.code, c.msg + '(HTTP ' + r.status + ')' + (c.code === 'other' || c.code === 'unsupported' ? '' : ''), c.hint); }
      let full = '', buf = '', usage = null;
      const dec = new TextDecoder();
      const line = l => {
        l = l.trim(); if (!l.startsWith('data:')) return; const d = l.slice(5).trim(); if (!d || d === '[DONE]') return;
        let j; try { j = JSON.parse(d); } catch { return; }
        if (j.error) throw mkErr(...Object.values(classify(JSON.stringify(j.error), j.error.code && /^\d+$/.test(String(j.error.code)) ? +j.error.code : 0, 'api')));
        const dl = j.choices && j.choices[0] && j.choices[0].delta; const c = dl && dl.content;
        if (typeof c === 'string' && c) { full += c; h.onDelta(c); }
        if (j.usage) usage = j.usage;
      };
      try { for await (const chunk of r.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } } if (buf) line(buf); }
      catch (e) { if (stopped) { if (full.trim()) h.onText(full.trim()); return; } if (e.info) throw e; const c = classify(String(e.cause && e.cause.code || e.message), 0, 'api'); throw mkErr(c.code, c.msg, c.hint); }
      if (full.trim()) h.onText(full.trim()); else if (!stopped) throw mkErr('other', '返答が空でした', 'モデルIDが合っているか確認してください');
      if (usage) h.onUsage({ in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 });
    } catch (e) { if (!stopped) h.onError(e.info || classify(e.message, 0, 'api')); }
  })();
  return { handle, done };
}
function runCli(conn, a, h) {
  const handle = { pid: 0 };
  const done = new Promise(resolve => {
    let child, gotErr = false, err = '', buf = '', gotAny = false; const st = {};
    const fin = () => { resolve(); };
    try {
      const file = resolveExe(conn.exe);
      if (!file) throw mkErr('cli_missing', 'CLIが見つかりません', 'インストールされているか、設定 → AI接続 の「実行ファイル」を確認してください');
      const args = [...(conn.preArgs || [])];
      if (conn.provider === 'opencode') {
        args.push('run', '--format', 'json');
        if (a.model) args.push('-m', a.model);
        if (a.nativeId) args.push('--session', a.nativeId);
      } else if (conn.provider === 'gemini') {
        args.push('-p', '.', '--output-format', 'stream-json');
        if (a.model) args.push('-m', a.model);
        if (a.perm === 'full') args.push('--yolo'); // 利用者が「全許可」を選んだ会話だけ。それ以外は緩めない
      } else throw mkErr('unsupported', 'この種類のCLIにはまだ対応していません');
      child = spawnCli(file, args, { cwd: a.cwd, env: a.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { h.onError(e.info || classify(e.message, 0, 'cli')); return fin(); }
    handle.pid = child.pid; handle.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(prompt_of(a, conn));
    const emit = ev => {
      for (const x of (conn.provider === 'opencode' ? parseOpencode(ev) : parseGemini(ev, st))) {
        gotAny = true;
        if (x.t === 'session') h.onSession(x.id); else if (x.t === 'text') h.onText(x.text); else if (x.t === 'tool') h.onTool(x.text);
        else if (x.t === 'usage') h.onUsage({ in: x.in, out: x.out }); else if (x.t === 'error') { gotErr = true; h.onError(classify(x.msg, 0, 'cli')); }
      }
    };
    const onLine = l => { l = l.trim(); if (!l.startsWith('{')) return; let ev; try { ev = JSON.parse(l); } catch { return; } emit(ev); };
    child.stdout.on('data', d => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', d => { err += d.toString('utf8'); if (err.length > 6000) err = err.slice(-6000); });
    child.on('error', e => { gotErr = true; h.onError(classify(e.message, 0, 'cli')); });
    child.on('close', code => {
      if (buf) onLine(buf);
      if (st.buf && st.buf.trim()) { h.onText(st.buf.trim()); st.buf = ''; }
      if (!handle.stopped && !gotErr && code !== 0) h.onError(classify(redact(err || '終了コード ' + code, a.key), 0, 'cli'));
      else if (!handle.stopped && !gotErr && !gotAny && code === 0) h.onError({ code: 'other', msg: '返答がありませんでした', hint: (err || '').trim().slice(-300) });
      fin();
    });
  });
  return { handle, done };
}
// 再開機能がないCLIは、これまでの会話を文章で渡す(再開できるCLIは自分の記憶を使うので渡さない)
const prompt_of = (a, conn) => (!conn.caps.resume && a.history && a.history.length) ? ('【これまでの会話(参考)】\n' + a.history.map(m => (m.role === 'user' ? 'ユーザー: ' : 'AI: ') + m.content).join('\n\n').slice(-12000) + '\n【ここまで】\n\n' + a.text) : a.text;

module.exports = { createStore, PRESETS, COST_LABEL, COSTS, classify, redact, test, fetchModels, run, parseOpencode, parseGemini, resolveExe, spawnCli, OK_ARG, OK_MODEL, dpapi };
