// ChatDango: Claude Code / Codex をLINE風チャットで使うローカルサーバー(依存ゼロ)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync, execFile } = require('child_process');
const crypto = require('crypto');

const importer = require('./importer');
const connLib = require('./lib/connections');
const conns = connLib.createStore(path.join(__dirname, 'data')); // AI接続の登録(APIキーは含まない。キーは secrets.json にDPAPIで暗号化)
let importCache = [];
const PORT = +process.env.CHATDANGO_PORT || 5178; // 別の場所で試すときだけ環境変数で変える
const DATA = path.join(__dirname, 'data', 'sessions.json');
// 新規インストールでは data/ に無いので、必要なときに作る
function noPluginsFile() {
  const f = path.join(__dirname, 'data', 'no-plugins.json');
  if (!fs.existsSync(f)) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{"enabledPlugins":{"vercel@claude-plugins-official":false}}'); } catch {} }
  return f;
}
const PUB = path.join(__dirname, 'public');
const IMG = path.join(__dirname, 'data', 'images');
try { fs.mkdirSync(IMG, { recursive: true }); } catch {}
const IMG_RE = /^[\w-]+\.(png|jpe?g|webp|gif)$/;
const themeLib = require('./lib/theme'); // 見た目テーマの背景(画像/動画)。設定自体は各端末の localStorage、ファイルだけここに置く
const THEME = path.join(__dirname, 'data', 'theme');
const httpLib = require('./lib/http'); // 圧縮・304・本文サイズ上限
const icons = require('./lib/iconstore').createIconStore(); // アイコン画像は一覧に埋め込まず /ico/<hash> で配る
const staticCache = httpLib.createStaticCache();
const okImages = a => (Array.isArray(a) ? a : []).filter(n => typeof n === 'string' && IMG_RE.test(n) && fs.existsSync(path.join(IMG, n))).slice(0, 10);

// 残量: Claudeは実行時の rate_limit_event を保存、Codexは最新セッションログの rate_limits を読む
const LIMITS = path.join(__dirname, 'data', 'limits.json');
let claudeLimit = null;
try { claudeLimit = JSON.parse(fs.readFileSync(LIMITS, 'utf8')); } catch {}
function codexLimit() {
  try {
    const root = path.join(require('os').homedir(), '.codex', 'sessions');
    const latest = d => fs.readdirSync(d).sort().pop();
    const files = [];
    const walk = (d, depth) => { if (depth === 3) { for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) files.push(path.join(d, f)); return; } for (const x of fs.readdirSync(d).sort().reverse().slice(0, 3)) walk(path.join(d, x), depth + 1); };
    walk(root, 0);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, 5)) {
      const st = fs.statSync(f), n = Math.min(st.size, 400000), fd = fs.openSync(f, 'r'), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
      const lines = b.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
        const rl = ev.payload && ev.payload.rate_limits; if (!rl) continue;
        const w = x => x && { pct: x.used_percent, mins: x.window_minutes, resetsAt: x.resets_at * 1000 };
        return { plan: rl.plan_type, primary: w(rl.primary), secondary: w(rl.secondary), at: Date.parse(ev.timestamp) || st.mtimeMs };
      }
    }
  } catch {}
  return null;
}
let codexLimitAt = 0, codexLimitVal = null; // ログを走査するので、短時間に何度も呼ばれても10秒に1回だけ読む
function limits() {
  if (Date.now() - codexLimitAt > 10000) { codexLimitVal = codexLimit(); codexLimitAt = Date.now(); }
  return { claude: claudeLimit, codex: codexLimitVal };
}

let sessions = [];
try { sessions = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
sessions.forEach(s => {
  if (s.running) s.messages.push({ role: 'sys', text: 'サーバーが再起動されたため、返答が途中で中断されました。もう一度送ってください', ts: Date.now() });
  s.running = false; s.queue = []; s._bgN = 0;
});
const validIcon = v => typeof v === 'string' && v.length <= 200000 && (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v) || (v.length <= 16 && !/[<>&"']/.test(v))) ? v : '';
const ttsAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const procs = new Map(); // sid -> child
const tasksLib = require('./lib/tasks');
const skillsLib = require('./lib/skills'), srcLib = require('./lib/skillsrc');
let tasksBusy = false, tasksPrev = null, tasksAt = 0, tasksLast = [];
let procsPrev = null, procsAt = 0, procsLast = { groups: [], total: {} };

// 保存: 整形なしで書く。AIが作業中は書き込みをまとめる(最大3秒待ち)。終了時は未保存分を必ず書く
let saveTimer = null, saveFirst = 0;
let saving = false, saveAgain = false;
function writeNow(sync) {
  clearTimeout(saveTimer); saveTimer = null; saveFirst = 0;
  const tmp = DATA + '.tmp';
  if (sync) { // 終了時: 書き終わるまで待つ
    try { fs.writeFileSync(tmp, JSON.stringify(sessions)); fs.renameSync(tmp, DATA); } catch (e) { console.error('save failed', e.message); }
    return;
  }
  if (saving) { saveAgain = true; return; } // 書き込み中に変わった分は、終わってからもう一度
  let json; try { json = JSON.stringify(sessions); } catch (e) { return console.error('save failed', e.message); }
  saving = true;
  fs.promises.writeFile(tmp, json).then(() => fs.promises.rename(tmp, DATA)).catch(e => console.error('save failed', e.message)).finally(() => { saving = false; if (saveAgain) { saveAgain = false; writeNow(); } });
}
function save() {
  const now = Date.now(); if (!saveFirst) saveFirst = now;
  clearTimeout(saveTimer);
  const busy = sessions.some(s => s.running), wait = Math.max(0, Math.min(busy ? 1500 : 200, saveFirst + 3000 - now));
  saveTimer = setTimeout(writeNow, wait);
}

const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(line);
}
// CPU/GPU使用率: 画面を開いている間だけ2秒ごとに測って配信する(設定でオフなら測らない)
const sysLib = require('./lib/sysstat').create();
let sysSeen = 0; // 画面が無くなっても30秒は測定を続ける(リロードのたびにGPU測定の起動待ちをしないため)
setInterval(() => {
  if (clients.size && prefs.sysstat !== false) { sysSeen = Date.now(); return broadcast({ type: 'sys', ...sysLib.sample() }); }
  if (prefs.sysstat === false || Date.now() - sysSeen > 30000) sysLib.stop();
}, 2000).unref();
process.on('exit', () => sysLib.stop());
const find = id => sessions.find(s => s.id === id);
// 新しいチャットに自動で付ける色: まだ使われていない色(全部使われていれば一番少ない色)を順に選ぶ
const AUTO_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#eab308', '#06b6d4', '#ef4444', '#14b8a6', '#8b5cf6'];
function autoColor() {
  const use = new Map(AUTO_COLORS.map(c => [c, 0]));
  for (const s of sessions) { const c = (s.color || '').toLowerCase(); if (use.has(c)) use.set(c, use.get(c) + 1); }
  let best = AUTO_COLORS[0]; for (const c of AUTO_COLORS) if (use.get(c) < use.get(best)) best = c;
  return best;
}
function slashItems(cwd, tool) {
  const out = new Map(), home = require('os').homedir();
  const desc = t => { const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t); const d = fm && /^description:\s*(.+)$/m.exec(fm[1]); return d ? d[1].trim().replace(/^["']|["']$/g, '').slice(0, 90) : ''; };
  const cmds = (dir, pre, src) => { let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = path.join(dir, e.name);
      if (e.isDirectory()) cmds(f, pre + e.name + ':', src);
      else if (/\.md$/i.test(e.name)) { let t = ''; try { t = fs.readFileSync(f, 'utf8').slice(0, 1500); } catch {} out.set(pre + e.name.slice(0, -3), { name: pre + e.name.slice(0, -3), desc: desc(t), src }); } } };
  // スキルは lib/skills の走査を使う(複数行の説明・リンクのスキルも拾う)。個人→作業フォルダの順に入れて、同名は作業フォルダ側が優先
  const skills = () => { for (const x of skillsLib.scan(home, cwd)) if (x.tool === tool) out.set(x.name, { name: x.name, desc: x.desc.slice(0, 90), src: x.scope === 'project' ? 'スキル(この作業フォルダ)' : 'スキル' }); };
  if (tool === 'codex') { // Codexはスキルを $名前 で呼ぶ(/は組み込みコマンド用でexecでは使えない)
    skills();
    return [...out.values()].map(x => ({ ...x, prefix: '$' })).sort((a, b) => a.name.localeCompare(b.name));
  }
  skills(); cmds(path.join(home, '.claude', 'commands'), '', 'コマンド');
  if (cwd) cmds(path.join(cwd, '.claude', 'commands'), '', 'コマンド(この作業フォルダ)');
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function lastText(s) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'user' || m.role === 'assistant') return m.text.slice(0, 60);
  }
  return '';
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const validEffort = v => EFFORTS.includes(v) ? v : '';
const validModel = v => (typeof v === 'string' && /^[A-Za-z0-9._:-]{0,60}$/.test(v.trim())) ? v.trim() : '';
function codexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.codex', 'models_cache.json'), 'utf8'));
    return (j.models || j).filter(m => m.visibility === 'list').map(m => ({ id: m.slug || m.id, label: m.display_name || m.slug || m.id })).filter(m => m.id);
  } catch { return []; }
}
function codexDefault() {
  try { const m = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(require('os').homedir(), '.codex', 'config.toml'), 'utf8')); return m ? m[1] : ''; } catch { return ''; }
}
// 作業フォルダがホーム/ドライブ直下の会話は、AIが実際にファイルを触っているプロジェクトのフォルダを会話ログから推定して使う
// (表示・Gitマーク・Git操作・フォルダを開く用。AIの起動フォルダ自体は変えない)
const isRootDir = d => { const r = path.resolve(d).replace(/[\\/]+$/, '').toLowerCase(); return r === path.resolve(require('os').homedir()).toLowerCase() || /^[a-z]:$/.test(r); };
const projMarks = ['.git', 'SPEC.md', 'package.json', 'CLAUDE.md', 'start.bat'];
function inferProj(s) {
  const c = s._projC; if (c && c.n === s.messages.length) return c.v;
  if (c && Date.now() - c.t < 120000) return c.v;
  const cnt = new Map(), seen = new Map(), re = /[A-Za-z]:[\\/][^\s"'<>|*?`]+/g;
  for (const m of s.messages.slice(-600)) {
    if (m.role !== 'tool' || !m.text) continue;
    for (let p of m.text.match(re) || []) {
      p = path.normalize(p.replace(/\//g, '\\').replace(/\\+/g, '\\')).replace(/[\\]+$/, ''); if (/AppData|\\\.claude|node_modules|\$RECYCLE/i.test(p)) continue;
      let d = seen.get(p);
      if (d === undefined) {
        d = '';
        try {
          let x = p; for (let i = 0; i < 12 && x; i++) {
            if (fs.existsSync(x)) { if (!fs.statSync(x).isDirectory()) x = path.dirname(x); break; }
            const u = path.dirname(x); if (u === x) { x = ''; break; } x = u;
          }
          for (let i = 0; x && i < 8 && !isRootDir(x); i++) {
            if (projMarks.some(k => fs.existsSync(path.join(x, k)))) { d = x; break; }
            const u = path.dirname(x); if (u === x) break; x = u;
          }
        } catch {}
        seen.set(p, d);
      }
      if (d) cnt.set(d, (cnt.get(d) || 0) + 1);
    }
  }
  let best = '', bn = 0; for (const [d, n] of cnt) if (n > bn) { best = d; bn = n; }
  s._projC = { n: s.messages.length, t: Date.now(), v: best }; return best;
}
const effCwd = s => (s.cwd && !isRootDir(s.cwd)) ? s.cwd : (inferProj(s) || s.cwd);
// GitHubに上げ済みか: フォルダから上へ .git を探し、config に github.com のリモートがあるかだけ見る(プロセス起動なし・30秒キャッシュ)
const ghCache = new Map();
function onGithub(cwd) {
  if (!cwd) return '';
  const c = ghCache.get(cwd); if (c && Date.now() - c.t < 30000) return c.v;
  let v = '';
  try {
    const home = path.resolve(require('os').homedir()).toLowerCase();
    let d = path.resolve(cwd);
    for (;;) {
      if (d.toLowerCase() === home || d === path.parse(d).root) break; // ホーム/ドライブ直下のリポジトリは対象外
      const gd = path.join(d, '.git'); if (fs.existsSync(gd) && !fs.statSync(gd).isDirectory()) break; // worktree/submodule は親を見ない
      const cf = path.join(gd, 'config');
      if (fs.existsSync(cf)) { const m = /url\s*=\s*\S*github\.com[:\/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/im.exec(fs.readFileSync(cf, 'utf8')); v = m ? 'https://github.com/' + m[1] + '/' + m[2] : ''; break; }
      const up = path.dirname(d); if (up === d) break; d = up;
    }
  } catch {}
  ghCache.set(cwd, { t: Date.now(), v }); return v;
}
const ctxMaxOf = s => s.ctxMax || (/\[1m\]/i.test(s.model || '') || (s.ctx || 0) > 200000 ? 1000000 : 200000); // 実測(resultのcontextWindow)優先、なければ推定
const BG_TPL_RE = /^@(aurora|sunset|stars|ocean|rain|lava|sakura)$/; // 組み込みの背景テンプレート(ファイルなし)
const validBgm = o => (o && (themeLib.NAME_RE.test(String(o.media || '')) || BG_TPL_RE.test(String(o.media || '')))) ? { media: o.media, dim: Math.min(80, Math.max(0, +o.dim || 0)), blur: Math.min(20, Math.max(0, +o.blur || 0)) } : null; // この会話だけの背景(null=全体の設定を使う)
const summary = s => ({ wt: s.wt ? { branch: s.wt.branch, from: s.wt.from } : null, bgm: s.bgm || null, ctxMax: ctxMaxOf(s), gh: onGithub(effCwd(s)) || '', proj: isRootDir(s.cwd) ? inferProj(s) : '', id: s.id, lineage: s.lineage || '', name: s.name, pinned: !!s.pinned, done: !!s.done, fmt: fmtOn(s), yomiyasu: !!s.yomiyasu, group: s.group || '', order: s.order, bg: s.bg || '', tool: s.tool, conn: s.conn || '', connName: s.tool === 'ext' ? ((conns.get(s.conn) || {}).name || '(削除された接続)') : '', cwd: s.cwd, perm: s.perm, color: s.color || '', icon: icons.urlOf(s.icon), mcp: s.mcp || 'auto', mcpOn: mcpOn(s), effort: s.effort || '', ctx: s.ctx || 0, lastEnd: s.lastEnd || 0, model: s.model || '', modelUsed: s.modelUsed || '', queued: (s.queue || []).length, running: !!s.running, startedAt: s.running ? (s.startedAt || 0) : 0, avgMs: (s.durs && s.durs.length) ? Math.round(s.durs.reduce((a, b) => a + b, 0) / s.durs.length) : 0, updatedAt: s.updatedAt, last: lastText(s) });
function addMsg(s, role, text, images, extra) {
  const m = { id: crypto.randomUUID().slice(0, 8), role, text, ts: Date.now(), ...(extra || {}) };
  if (images && images.length) m.images = images;
  s.messages.push(m);
  s.updatedAt = m.ts;
  save();
  broadcast({ type: 'msg', sid: s.id, msg: m, summary: summary(s) });
}
function setRunning(s, v) {
  s.running = v;
  broadcast({ type: 'state', sid: s.id, summary: summary(s) });
}

function killTree(child) {
  if (child.abort) { try { child.abort(); } catch {} return; } // API接続(通信の中断)
  if (!child.pid) return;
  try { const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('error', () => {}); k.unref(); } catch {} // 結果を待たない(待つと、止めるたびに全会話の表示が数百ミリ秒止まる)
}
function killTreeSync(child) {
  if (child.abort) { try { child.abort(); } catch {} return; }
  if (!child.pid) return;
  try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
}

function shortInput(inp) {
  if (!inp) return '';
  const v = inp.command || inp.file_path || inp.pattern || inp.path || inp.url || inp.description || inp.prompt || JSON.stringify(inp);
  return String(v).replace(/\s+/g, ' ').slice(0, 140);
}

function handleClaude(s, ev) {
  if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.unifiedWindows) {
    const w = ev.rate_limit_info.unifiedWindows, c = x => x && { pct: x.utilization <= 1 ? x.utilization * 100 : x.utilization, resetsAt: x.resetsAt * 1000 };
    claudeLimit = { fiveHour: c(w.five_hour), sevenDay: c(w.seven_day), at: Date.now() };
    try { fs.writeFileSync(LIMITS, JSON.stringify(claudeLimit)); } catch {}
    broadcast({ type: 'limits', limits: limits() });
    return;
  }
  if (ev.type === 'stream_event' && ev.event) {
    const e = ev.event;
    if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text') s._live = '';
    else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
      s._live = (s._live || '') + e.delta.text;
      broadcast({ type: 'delta', sid: s.id, d: e.delta.text });
    }
    return;
  }
  if (ev.session_id) s.nativeId = ev.session_id;
  if (ev.type === 'assistant' && ev.message && ev.message.usage) { const u = ev.message.usage; const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); if (t > 0) s.ctx = t; }
  if (ev.type === 'system' && ev.subtype === 'init' && ev.model) s.modelUsed = ev.model;
  else if (ev.type === 'assistant' && ev.message && ev.message.model && ev.message.model !== '<synthetic>') s.modelUsed = ev.message.model;
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text.trim()) { s._gotText = true; s._live = ''; addMsg(s, 'assistant', b.text.trim()); }
      else if (b.type === 'tool_use') addMsg(s, 'tool', `${b.name}  ${shortInput(b.input)}`);
    }
  } else if (ev.type === 'result') {
    s._done = true;
    try { const cw = Object.values(ev.modelUsage || {}).map(x => x && x.contextWindow).filter(Boolean); if (cw.length) s.ctxMax = Math.max(...cw); } catch {}
    if (ev.is_error) addMsg(s, 'sys', 'エラー: ' + (ev.result || ev.subtype || '不明'));
    else if (!s._gotText && ev.result) addMsg(s, 'assistant', String(ev.result));
  }
}

function handleCodex(s, ev) {
  if (ev.type === 'turn.completed' || ev.type === 'turn.failed') s._done = true;
  if (ev.type === 'thread.started' && ev.thread_id) s.nativeId = ev.thread_id;
  else if (ev.type === 'item.completed' && ev.item) {
    const it = ev.item;
    if (it.type === 'agent_message' && it.text) { s._gotText = true; addMsg(s, 'assistant', it.text.trim()); }
    else if (it.type === 'command_execution') addMsg(s, 'tool', 'command  ' + String(it.command || '').replace(/\s+/g, ' ').slice(0, 140));
    else if (it.type === 'file_change') addMsg(s, 'tool', 'edit  ' + (it.changes || []).map(c => c.path).join(', ').slice(0, 140));
    else if (it.type === 'mcp_tool_call') addMsg(s, 'tool', `${it.server || 'mcp'}  ${it.tool || ''}`);
    else if (it.type === 'error') codexErr(s, it.message || '');
  } else if (ev.type === 'turn.failed') addMsg(s, 'sys', 'エラー: ' + ((ev.error && ev.error.message) || '失敗'));
  else if (ev.type === 'error' && ev.message) codexErr(s, ev.message);
}
// Codexの再接続メッセージ(WebSocket切断→HTTPSへ切替)はOpenAI側の通信の揺れで、自動で続行される。エラー扱いせず1ターンに1回だけ静かに知らせる
function codexErr(s, msg) {
  if (/^Reconnecting...|Falling back from WebSockets/i.test(msg)) {
    if (!s._recon) { s._recon = true; addMsg(s, 'sys', '通信が一時的に切れたため、Codexが自動で再接続しています(OpenAI側の接続の問題で、そのまま続きます)'); }
    return;
  }
  addMsg(s, 'sys', 'エラー: ' + msg);
}

function withImages(text, images) {
  const files = (images || []).map(n => path.join(IMG, n));
  return { files, text: files.length ? text + '\n\n[添付画像(Readツール等で見てください)]\n' + files.join('\n') : text };
}
function beginTurn(s) { s._recon = false; s._gotText = false; s._done = false; s.startedAt = Date.now(); }
// 1ターン終了の後始末(Claude常駐・Codex共通)
const HANDOFF_PROMPT = `この会話を、新しい会話(あなたは今回の記憶を持ちません)に引き継ぐための【詳細な引き継ぎ資料】を作成してください。
- 新しい会話のAIがこの資料だけで、質問し直さずに同じ精度で作業を再開できる詳しさにすること。省略しすぎない。
- 推測や曖昧な記憶で書かない。確かでないことは「未確認」と明記する。必要ならファイル(SPEC.md等)を読んで最新の状態を確認してよい(ただし大きなファイルの全文読みは避ける)。
- 出力は貼り付け用のMarkdown本文のみ。前置き・後書き・あいさつは書かない。
次の見出しで構成してください:
## 1. 目的・背景(何のための作業か、ユーザーの意図)
## 2. 現在の状態(完了/進行中/未着手を分けて。具体的に)
## 3. 決定事項とその理由(却下した案とその理由も)
## 4. 重要なファイル・パス・コマンド・起動方法(フルパスで)
## 5. ユーザーの方針・好み・禁止事項(会話中に言われたこと)
## 6. 既知の問題・落とし穴・注意点
## 7. 次にやること(優先順)
## 8. 未解決の疑問・確認待ち
## 9. 再開時に最初に読むべきファイル`;
// 会話をgzipで data/archive/ に保存し、同じ設定の新しいチャットへ引き継ぎ資料だけを持って移る(元の会話は一覧から外れる)
const ARCHIVE = path.join(__dirname, 'data', 'archive');
const arcMeta = new Map(); // 一覧表示用の軽い情報(毎回gunzipしないため)
const safeName = n => String(n).replace(/[\\\/:*?"<>|\s]+/g, '_').slice(0, 40);
function finishArchive(s, txt) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const file = safeName(s.name) + '-' + s.id.slice(0, 8) + '-' + new Date().toISOString().slice(0, 10) + '-' + (Date.now() % 100000) + '.json.gz';
  s.lineage = s.lineage || s.id; // 同じチャットの系列(アーカイブ回数を数えるため)
  const gz = zlib.gzipSync(JSON.stringify(s));
  fs.writeFileSync(path.join(ARCHIVE, file), gz);
  // cwd は effCwd: ホーム直下のチャットの推定プロジェクトは履歴が空になると消えるので、作業フォルダとして確定して渡す
  const n = {
    id: crypto.randomUUID(), lineage: s.lineage, name: s.name, tool: s.tool, cwd: effCwd(s), ...(s.wt ? { wt: s.wt } : {}), perm: s.perm, color: s.color || '', icon: s.icon || '', bg: s.bg || '', group: s.group || '', order: s.order, pinned: !!s.pinned,
    mcp: s.mcp, model: s.model, effort: s.effort, nativeId: null, ...(s.tool === 'ext' ? { conn: s.conn, native: {} } : {}), messages: [], running: false, createdAt: Date.now(), updatedAt: Date.now(),
  };
  const old = procs.get(s.id); if (old) { old.replaced = true; killTree(old); procs.delete(s.id); }
  sessions = sessions.filter(x => x !== s); sessions.push(n);
  try { const d = path.join(__dirname, 'data', 'handoffs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, safeName(s.name) + '-' + Date.now() + '.md'), txt); } catch {}
  addMsg(n, 'sys', '━━━ アーカイブから引き継ぎ ━━━\n前の会話(' + s.messages.length + '件 / ' + Math.round(gz.length / 1024) + 'KBに圧縮)を data/archive/' + file + ' に保存しました(設定 → アーカイブ から元に戻せます)。\nAIは引き継ぎ資料だけを覚えて続けます。');
  save();
  broadcast({ type: 'handoff', from: s.id, sid: n.id, summary: summary(n) });
  broadcast({ type: 'deleted', sid: s.id });
  setTimeout(() => { if (find(n.id)) send(n, '以下は、これまでの会話の引き継ぎ資料です。この内容を前提に続きを進めます。把握したら「引き継ぎ内容を把握しました」と一言だけ返してください(作業はまだ始めない)。\n(元の全履歴: ' + path.join(ARCHIVE, file) + ' ※gzip圧縮のJSON。通常は読まず、資料で足りないときだけ展開して参照)\n\n' + txt); }, 300);
}
function finishHandoff(s) {
  s._handoff = false;
  const arch = !!s._archive; s._archive = false;
  let txt = '';
  for (let i = s.messages.length - 1; i >= 0; i--) { const m = s.messages[i]; if (m.role === 'assistant') { txt = m.text; break; } if (m.role === 'user') break; }
  if (!txt.trim()) { addMsg(s, 'sys', '引き継ぎ資料を取得できませんでした' + (arch ? '(アーカイブは中止しました。会話はそのまま残っています)' : '')); return; }
  if (arch) return finishArchive(s, txt);
  // 同じチャットのまま、AI側の記憶(native会話)だけを引き継ぎ資料で入れ替える。画面の履歴はそのまま残る
  const old = procs.get(s.id); if (old) { old.replaced = true; killTree(old); procs.delete(s.id); }
  s.nativeId = null; s.native = {}; s.ctx = 0; s.mcpOn = false;
  addMsg(s, 'sys', '━━━ ここから引き継ぎ（' + new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '）━━━\n「' + s.name + '」の記憶を、すぐ上の引き継ぎ資料に入れ替えました。\nこの線より上の履歴は画面に残るだけで、AIは資料の内容だけを覚えて続けます(以降は軽くなります)');
  setTimeout(() => { if (!s.running && find(s.id)) send(s, '以下は、これまでの会話の引き継ぎ資料です。この内容を前提に続きを進めます。把握したら「引き継ぎ内容を把握しました」と一言だけ返してください(作業はまだ始めない)。\n\n' + txt); }, 100);
  try { const d = path.join(__dirname, 'data', 'handoffs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, s.name.replace(/[\\\/:*?"<>|]/g, '_') + '-' + Date.now() + '.md'), txt); } catch {}
  save();
}
function endTurn(s, code, err) {
  s._live = ''; s.lastEnd = Date.now();
  if (s._done && !s._stopped && s.startedAt) s.durs = (s.durs || []).concat(Date.now() - s.startedAt).slice(-10);
  if (s._stopped) { s._stopped = false; s._stopped_q = true; addMsg(s, 'sys', '停止しました' + ((s.queue || []).length ? '(待機中の ' + s.queue.length + ' 件は破棄)' : '')); }
  else if (!s._done && !s.messages.length && /is not recognized|not found|認識されていません|見つかりません|ENOENT/i.test(err || '')) addMsg(s, 'sys', `${s.tool === 'codex' ? 'Codex' : 'Claude Code'} がこのPCで見つかりません。
・入れていない場合: README の「必要なもの」を見て、インストールしてログインしてください。
・入れているのに出る場合: PowerShell で ${s.tool === 'codex' ? 'codex' : 'claude'} --version が動くか確認してください。
(詳細) ${(err || '').trim().slice(-300)}`);
  else if (!s._done) addMsg(s, 'sys', `返答の途中でAIのプロセスが終了しました(終了コード ${code})\n${(err || '').trim().slice(-600)}`);
  const wasHandoff = s._handoff && s._done;
  if (!wasHandoff) s._handoff = false;
  setRunning(s, false);
  save();
  if (wasHandoff) finishHandoff(s);
  const q = s.queue || []; s.queue = [];
  if (s._stopped_q) { s._stopped_q = false; q.length = 0; }
  if (q.length) { setTimeout(() => { if (!s.running && find(s.id)) send(s, q.map(x => x.text).join('\n\n'), q.flatMap(x => x.images)); }, 100); }
}

// トークン節約: 自動compactを20万で発動(既定は約97万まで膨らむ) + キャッシュ保持1時間
const claudeEnv = () => ({ ...childEnv(), CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
let iconBusy = 0;
const childEnv = () => { const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; return env; };
// MCP: 'auto'(既定)=必要そうな依頼が来たときだけ有効化 / 'on'=常時 / 'off'=常に無効
const mcpWord = text => { const m = String(text).match(MCP_RE); return m ? '「' + m[0] + '」' : ''; };
const MCP_RE = /ブラウザ|スクショ|スクリーンショット|playwright|サイトを開|ページを開|URLを開|gmail|メール|カレンダー|予定|スケジュール|ドライブ|drive|youtube|ユーチューブ|字幕|文字起こし|vercel|デプロイ|mcp/i;
const mcpOn = s => s.mcp === 'on' || ((s.mcp || 'auto') === 'auto' && !!s.mcpOn);
const validMcp = v => v === 'on' || v === 'off' || v === 'auto' ? v : 'auto';
const claudeKey = s => [s.model || '', s.effort || '', s.perm, s.cwd, mcpOn(s) ? 'mcp' : '', fmtOn(s) ? 'fmt' : ''].join('|');

// Claude: 会話ごとに常駐プロセス(--input-format stream-json)。ターンが終わっても生きているので、
// バックグラウンドのAgent/Bash/Monitorが落ちず、完了通知で自動的に次のターンも始まる。2通目以降は起動待ちなし。
const JP_RULE = '返答はつねにすべて日本語で書くこと。作業が長くなっても途中経過の一言やツール実行前の説明を含めて英語を混ぜない。ただしコードやコマンドや固有名詞はそのままでよい。';
// 自動振り分け: 親は最上位モデル固定で判断/設計、実装はAgentツールのmodel引数で安いモデルへ(shell経由なので空白や記号を含めない)
const AUTO_CLAUDE = '【自動振り分けモード】あなたは司令塔です。判断と設計と最終レビューは自分で行い、まとまった実装や調査はAgentツールのmodel引数で振り分けてください。ファイル検索や機械的な置換やテスト実行はhaiku、通常の実装や修正はsonnet、設計が割れる難所だけopusを使う。数行で済む修正は自分でやる。サブエージェントへの指示には目的とファイル名と完了条件をすべて書き、報告は短く求める。完了したら結果を確認して自分でユーザーに報告する。';
// チャット表示用の書式指示(会話ごとにオン/オフ。既定オン)。shell経由なので空白・引用符・<>|&^%・半角かっこを含めない
const FMT_RULE = 'チャット画面はMarkdownで表示されます。見出しや箇条書きや表で読みやすく書き、コードやコマンドやファイルの中身は言語名つきのコードブロックに入れてください。大事な語や注意点は{赤:語}{青:語}{緑:語}{黄:語}のように色を付けて目立たせてかまいませんが、使いすぎないでください。';
const fmtOn = s => s.fmt !== false;
// yomiyasu(日本語の推敲スキル・MIT)を作業フォルダに入れる。vendor/yomiyasu を丸ごとコピー(LICENSE も一緒)。既にあれば上書きしない
const yy = require('./lib/yomiyasu');
const YY_BUNDLED = path.join(__dirname, 'vendor', 'yomiyasu'), YY_LATEST = path.join(__dirname, 'data', 'yomiyasu-latest');
// 更新ボタンで取り込んだ新しい版があればそちらを、なければ同梱版を使う
const yySrc = () => fs.existsSync(path.join(YY_LATEST, 'SKILL.md')) && yy.cmpVer(yy.versionOf(YY_LATEST), yy.versionOf(YY_BUNDLED)) > 0 ? YY_LATEST : YY_BUNDLED;
const yyDest = s => path.join(s.cwd, s.tool === 'codex' ? '.agents' : '.claude', 'skills', 'yomiyasu');
// yomiyasu を公式リリースの最新版にし、入れてあるチャットのコピーも入れ替える。{ ok, current, latest, updated }
async function updateYomiyasu() {
  const tag = await yy.latestTag();
  if (yy.cmpVer(tag, yy.versionOf(yySrc())) > 0) await yy.fetchRelease(tag, YY_LATEST);
  const cur = yy.versionOf(yySrc()); let updated = 0;
  for (const s of sessions) {
    if (!s.yomiyasu || !s.cwd) continue;
    const d = yyDest(s);
    if (!fs.existsSync(path.join(d, 'VENDORED.txt')) || yy.cmpVer(yy.versionOf(d), cur) >= 0) continue;
    fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(yySrc(), d, { recursive: true }); updated++;
  }
  return { ok: true, current: cur, latest: tag, updated };
}
function installYomiyasu(s) {
  if (s.tool !== 'claude' && s.tool !== 'codex') return 'この種類のAIでは使えません(Claude Code / Codex のみ)';
  if (!fs.existsSync(path.join(yySrc(), 'SKILL.md'))) return 'vendor/yomiyasu が見つかりません';
  if (!s.cwd) return '作業フォルダが未設定です';
  const dest = yyDest(s);
  if (fs.existsSync(dest)) { s.yomiyasu = true; return ''; }
  try { fs.cpSync(yySrc(), dest, { recursive: true }); } catch (e) { return 'yomiyasuを入れられませんでした: ' + e.message; }
  s.yomiyasu = true;
  const notes = [];
  if (isRootDir(s.cwd)) notes.push('このフォルダ(ホーム/ドライブ直下)に入れました。同じフォルダを使う他のチャットでも使えます');
  if (!pythonFound()) notes.push('Python 3 が見つかりません。推敲そのものは使えますが、補助チェックのスクリプトは動きません(https://www.python.org/ から入れられます)');
  return notes.join('\n');
}
// yomiyasuの補助スクリプト用。python / py / python3 のどれかが動けば true(結果は覚える)
let pyFoundV = null;
function pythonFound() {
  if (pyFoundV !== null) return pyFoundV;
  pyFoundV = ['python', 'py', 'python3'].some(c => { try { execSync(c + ' --version', { stdio: 'ignore', timeout: 4000, windowsHide: true }); return true; } catch { return false; } });
  return pyFoundV;
}
// オフ: こちらが入れたコピー(VENDORED.txt がある)だけ消す。自分で置いた同名スキルには触らない
function removeYomiyasu(s) {
  s.yomiyasu = false;
  const dest = yyDest(s);
  try {
    if (!fs.existsSync(dest)) return '';
    if (!fs.existsSync(path.join(dest, 'VENDORED.txt'))) return 'skills/yomiyasu は自分で置いたものらしいので消しませんでした';
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (e) { return 'yomiyasuを外せませんでした: ' + e.message; }
  return '';
}
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const isAuto = s => s.model === 'auto';
function codexAutoText() {
  const list = codexModels(), top = codexDefault() || (list[0] || {}).id || '', sub = (list.filter(m => m.id !== top).pop() || {}).id || '';
  if (!sub) return '';
  return '[自動振り分けモード] あなたは司令塔。判断と設計と最終レビューは自分で行う。まとまった実装や機械的な作業は、シェルで codex exec --skip-git-repo-check -s workspace-write -m ' + sub + ' - を起動し、標準入力で目的/ファイル名/完了条件をすべて渡して任せる。数行で済む修正は自分でやる。結果は必ず自分で確認してからユーザーに報告する。\n\n';
}
function claudeProc(s) {
  const old = procs.get(s.id);
  if (old && old.key === claudeKey(s)) return old;
  if (old) { old.replaced = true; killTree(old); procs.delete(s.id); } // モデル/思考/権限/フォルダを変えたら作り直し
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (s.perm === 'full') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'acceptEdits');
  if (isAuto(s)) args.push('--model', CLAUDE_MODELS[0].id); else if (s.model) args.push('--model', s.model);
  if (s.effort) args.push('--effort', s.effort);
  // 作業が長くなると英語に流れるので、システムプロンプトで常に日本語を指定する(空白や記号を含めない: shell経由のため)
  args.push('--append-system-prompt', JP_RULE + (fmtOn(s) ? FMT_RULE : '') + (isAuto(s) ? AUTO_CLAUDE : ''));
  if (!mcpOn(s)) { args.push('--strict-mcp-config'); args.push('--settings', '"' + noPluginsFile() + '"'); } // MCPとVercelプラグイン(スキル約40本)を読み込まない(実測 約4,700トークン減)
  if (sec.safeId(s.nativeId)) args.push('--resume', s.nativeId);
  const child = spawn('claude', args, { cwd: s.cwd, shell: true, windowsHide: true, env: claudeEnv() });
  child.key = claudeKey(s); child.persistent = true;
  procs.set(s.id, child);
  s._bgN = 0;
  child.stdin.on('error', () => {});
  let buf = '', err = '';
  const onLine = line => {
    line = line.trim();
    if (!line.startsWith('{')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    // 自分が送っていないのに動き出した = バックグラウンド完了通知などによる自動ターン
    if (!s.running && ((ev.type === 'system' && ev.subtype === 'init') || ev.type === 'assistant' || ev.type === 'stream_event')) { beginTurn(s); setRunning(s, true); }
    if (ev.type === 'system' && ev.subtype === 'task_started') s._bgN = (s._bgN || 0) + 1;
    else if (ev.type === 'system' && ev.subtype === 'task_notification') s._bgN = Math.max(0, (s._bgN || 0) - 1);
    handleClaude(s, ev);
    if (ev.type === 'result' && s.running) endTurn(s, 0, err);
  };
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', d => { err += d.toString('utf8'); if (err.length > 4000) err = err.slice(-4000); });
  child.on('error', e => addMsg(s, 'sys', '起動失敗: ' + e.message));
  child.on('close', code => {
    if (procs.get(s.id) === child) procs.delete(s.id);
    if (child.replaced) return;
    if (s.running) endTurn(s, code, err);
  });
  return child;
}
function sendClaude(s, text) {
  if (!prefs.mcpAsk && (s.mcp || 'auto') === 'auto' && !s.mcpOn && MCP_RE.test(text)) { s.mcpOn = true; addMsg(s, 'sys', mcpWord(text) + ' を検知したため、この会話のMCPを有効にしました(以降も有効のまま。設定で変更可)'); }
  beginTurn(s);
  const child = claudeProc(s);
  setRunning(s, true);
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
}

function sendCodex(s, text, files) {
  if (!prefs.mcpAsk && (s.mcp || 'auto') === 'auto' && !s.mcpOn && MCP_RE.test(text)) { s.mcpOn = true; addMsg(s, 'sys', mcpWord(text) + ' を検知したため、この会話のMCPを有効にしました(以降も有効のまま。設定で変更可)'); }
  beginTurn(s);
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (s.perm === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-s', 'workspace-write');
  if (s.model && !isAuto(s)) args.push('-m', s.model);
  if (s.effort && s.effort !== 'max') args.push('-c', 'model_reasoning_effort="' + s.effort + '"');
  if (!mcpOn(s)) args.push('-c', 'mcp_servers.playwright.enabled=false'); // 毎回のnpx起動+ツール定義を省く
  s.modelUsed = (isAuto(s) ? '' : s.model) || codexDefault();
  if (sec.safeId(s.nativeId)) args.push('resume', s.nativeId);
  for (const f of files) args.push('--image="' + f + '"');
  args.push('-');
  const child = spawn('codex', args, { cwd: s.cwd, shell: true, windowsHide: true, env: childEnv() });
  procs.set(s.id, child);
  setRunning(s, true);
  child.stdin.on('error', () => {});
  child.stdin.end((isAuto(s) ? codexAutoText() : '') + text);
  let buf = '', err = '';
  const onLine = line => {
    line = line.trim();
    if (!line.startsWith('{')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    handleCodex(s, ev);
  };
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', d => { err += d.toString('utf8'); if (err.length > 4000) err = err.slice(-4000); });
  child.on('error', e => addMsg(s, 'sys', '起動失敗: ' + e.message));
  let fin = false;
  const finish = code => {
    if (fin) return; fin = true;
    if (buf) onLine(buf);
    if (procs.get(s.id) === child) procs.delete(s.id);
    broadcast({ type: 'limits', limits: limits() });
    endTurn(s, code, err);
  };
  child.on('close', finish);
  // Codexが起動した常駐プロセス(開発サーバーなど)が出力の口を握ったままだと、本体が終わっても 'close' が来ず「実行中」のまま固まる。終了から3秒たって来なければ、口を閉じて終わらせる
  child.forceEnd = () => { if (fin) return; try { child.stdout.destroy(); child.stderr.destroy(); } catch {} finish(child.exitCode); };
  child.on('exit', () => setTimeout(child.forceEnd, 3000));
}

// ---- AI接続(OpenCode / Gemini CLI / OpenAI互換API など): 共通アダプター経由 ----
const toolLabel = s => s.tool === 'claude' ? 'Claude Code' : s.tool === 'ext' ? ((conns.get(s.conn) || {}).name || '外部AI') : 'Codex';
const validExtModel = v => (typeof v === 'string' && connLib.OK_MODEL.test(v.trim())) ? v.trim() : '';
function sendExt(s, text, images) {
  beginTurn(s); setRunning(s, true);
  const fail = msg => { addMsg(s, 'sys', msg); s._done = true; endTurn(s, 0, ''); };
  const conn = conns.get(s.conn);
  if (!conn) return fail('この会話の接続が削除されています。設定 → AI接続 で作り直すか、別のAIで新しい会話を作ってください(履歴はそのまま残っています)');
  if (!conn.enabled) return fail('接続「' + conn.name + '」は無効です。設定 → AI接続 で有効にしてください(入力と履歴はそのまま残っています)');
  if (images && images.length && !conn.caps.image) addMsg(s, 'sys', '「' + conn.name + '」は画像に対応していないため、添付した画像は送られません');
  const model = s.model || conn.defaultModel || '';
  s.modelUsed = model;
  let key = '';
  if (conn.kind === 'api') { try { key = conns.getKey(conn); } catch (e) { return fail('APIキーを読み出せませんでした: ' + e.message + '\n対処: 設定 → AI接続 でキーを入れ直してください'); } }
  // 直前までの会話(今回の発言として積まれている末尾のユーザー発言は除く)
  const ms = s.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
  while (ms.length && ms[ms.length - 1].role === 'user' && (text.includes(ms[ms.length - 1].text.trim()) || ms[ms.length - 1].text.includes('⟦会話:') || ms[ms.length - 1].text.startsWith('【アーカイブして'))) ms.pop();
  const history = ms.slice(-40).map(m => ({ role: m.role, content: m.text }));
  const tail = () => { s._live = ''; };
  const hd = {
    onSession: id => { s.native = s.native || {}; s.native[conn.id] = id; },
    onText: t => { s._gotText = true; tail(); addMsg(s, 'assistant', t); },
    onDelta: d => { s._live = (s._live || '') + d; broadcast({ type: 'delta', sid: s.id, d }); },
    onTool: t => addMsg(s, 'tool', t),
    onUsage: u => { s.usage = { in: ((s.usage || {}).in || 0) + (u.in || 0), out: ((s.usage || {}).out || 0) + (u.out || 0) }; },
    onError: i => addMsg(s, 'sys', 'エラー(' + conn.name + '): ' + i.msg + (i.hint ? '\n対処: ' + i.hint : '')),
  };
  const a = { text, model, cwd: s.cwd, perm: s.perm, nativeId: sec.safeId((s.native || {})[conn.id]) ? s.native[conn.id] : '', history: conn.kind === 'api' ? history.concat([{ role: 'user', content: text }]) : history, key, env: { ...childEnv(), ...(conn.env || {}) }, system: JP_RULE };
  const r = connLib.run(conn, a, hd);
  procs.set(s.id, r.handle);
  r.done.then(() => { if (procs.get(s.id) === r.handle) procs.delete(s.id); s._done = true; endTurn(s, 0, ''); });
}
// 別名(fable/opus/sonnet/haiku)を渡すと Claude Code が常に最新のモデルに解決する。新モデルが出ても一覧の更新は不要
const CLAUDE_MODELS = [{ id: 'fable', label: 'Fable(最新)' }, { id: 'opus', label: 'Opus(最新)' }, { id: 'sonnet', label: 'Sonnet(最新)' }, { id: 'haiku', label: 'Haiku(最新)' }];
const BUILTIN_CAPS = { chat: true, image: true, files: true, exec: true, resume: true, approval: false, stream: true, stop: true };
function connList() {
  const ti = toolsInfo();
  const bi = ['claude', 'codex'].map(k => ({
    id: k, builtin: true, kind: 'agent', provider: k, name: k === 'claude' ? 'Claude Code' : 'Codex', enabled: !!ti[k].show,
    status: { status: ti[k].installed ? 'available' : 'not_installed', detail: ti[k].installed ? '検出済み(ログイン状態は送信時に判定されます)' : 'このPCで見つかりません', at: toolDet.t },
    models: (k === 'claude' ? CLAUDE_MODELS : codexModels()).map(m => ({ id: m.id, label: m.label, cost: 'unknown', src: 'preset' })), defaultModel: '', caps: BUILTIN_CAPS,
  }));
  const custom = conns.list().map(c => conns.view(c, conns.hasKey(c)));
  const all = [...bi, ...custom], d = conns.defaultId();
  return { list: all, defaultId: all.some(c => c.id === d && c.enabled) ? d : ((all.find(c => c.enabled) || {}).id || ''), presets: Object.entries(connLib.PRESETS).map(([k, v]) => ({ key: k, label: v.label, kind: v.kind, note: v.note, baseUrl: v.baseUrl || '', exe: v.exe || '', caps: v.caps })), costLabel: connLib.COST_LABEL };
}
async function connApi(req, res, p, local) {
  let m;
  if (req.method === 'GET' && p === '/api/connections') { json(res, connList()); return true; }
  if (!(p === '/api/connections' || p.startsWith('/api/connections/'))) return false;
  if (!local) { json(res, { error: '接続の変更・テストはPC本体からのみ可能です' }, 403); return true; }
  if (uiOnly(req, res)) return true;
  const fail = (e, code) => json(res, { error: (e.info ? e.info.msg + (e.info.hint ? '(' + e.info.hint + ')' : '') : e.message) }, code || 400);
  try {
    if (req.method === 'POST' && p === '/api/connections') { const o = conns.create(await body(req)); json(res, conns.view(o, conns.hasKey(o))); return true; }
    if (req.method === 'POST' && p === '/api/connections/default') { conns.setDefault(String((await body(req)).id || '')); json(res, { ok: true }); return true; }
    if ((m = p.match(/^\/api\/connections\/(claude|codex)$/)) && req.method === 'POST') {
      const b = await body(req); if (typeof b.enabled === 'boolean') { prefs.tools = { ...(prefs.tools || {}), [m[1]]: b.enabled ? 'auto' : 'off' }; fs.writeFileSync(PREFS, JSON.stringify(prefs)); }
      json(res, { ok: true }); return true;
    }
    if ((m = p.match(/^\/api\/connections\/(claude|codex)\/test$/)) && req.method === 'POST') {
      toolDet.t = 0; const r = await connLib.test({ kind: 'cli', exe: m[1], preArgs: [], caps: BUILTIN_CAPS }, '', childEnv()); json(res, r); return true;
    }
    if ((m = p.match(/^\/api\/connections\/(c_\w+)(?:\/(key|test|models))?$/))) {
      const c = conns.get(m[1]); if (!c) { json(res, { error: '存在しない接続です' }, 404); return true; }
      const act = m[2];
      if (req.method === 'DELETE' && !act) { conns.remove(c.id); json(res, { ok: true, used: sessions.filter(s => s.conn === c.id).length }); return true; }
      if (req.method === 'POST' && !act) { const o = conns.update(c.id, await body(req)); json(res, conns.view(o, conns.hasKey(o))); return true; }
      if (req.method === 'POST' && act === 'key') { conns.setKey(c.id, (await body(req)).key); json(res, { ok: true, hasKey: conns.hasKey(c) }); return true; }
      if (req.method === 'POST' && act === 'test') {
        let key = ''; if (c.kind === 'api') { try { key = conns.getKey(c); } catch (e) { return fail(e), true; } }
        const r = await connLib.test(c, key, { ...childEnv(), ...(c.env || {}) }); conns.status.set(c.id, r); json(res, r); return true;
      }
      if (req.method === 'POST' && act === 'models') {
        let key = ''; if (c.kind === 'api') { try { key = conns.getKey(c); } catch (e) { return fail(e), true; } }
        let got; try { got = await connLib.fetchModels(c, key, { ...childEnv(), ...(c.env || {}) }); } catch (e) { return fail(e, 502), true; }
        const keep = (c.models || []).filter(x => x.src !== 'fetched'), ids = new Set(keep.map(x => x.id));
        const o = conns.update(c.id, { models: [...keep, ...got.filter(x => !ids.has(x.id))] }); json(res, conns.view(o, conns.hasKey(o))); return true;
      }
    }
  } catch (e) { fail(e); return true; }
  json(res, { error: 'not found' }, 404); return true;
}

// ---- 会話の共有: 他の会話/プロジェクトに貼り付けて使う ----
// 参照トークン ⟦会話:先頭8桁|名前⟧ を貼ると、送信時に「記録ファイルの場所+直近の要点」へ展開される(全文は載せない=軽量。必要ならAIがファイルを読む)
const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
function transcript(s, last) {
  const ms = s.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim());
  const pick = last ? ms.slice(-last) : ms;
  let out = '# 会話「' + s.name + '」(' + toolLabel(s) + ' / ' + s.cwd + ')\n※ツール実行ログは省略。\n\n';
  for (const m of pick) out += '## ' + (m.role === 'user' ? 'ユーザー' : 'AI') + ' ' + new Date(m.ts).toLocaleString('ja-JP') + '\n' + m.text.trim() + '\n\n';
  return out;
}
function shareFile(s) {
  const d = path.join(__dirname, 'data', 'shares'); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, s.name.replace(/[\\/:*?"<>|]/g, '_') + '-' + s.id.slice(0, 8) + '.md');
  fs.writeFileSync(f, transcript(s, 0)); return f;
}
function expandRefs(text) {
  return text.replace(/⟦会話:([0-9a-f]{8})[^⟧]*⟧/g, (all, id) => {
    const t = sessions.find(x => x.id.startsWith(id)); if (!t) return all;
    let f = ''; try { f = shareFile(t); } catch {}
    const ms = t.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text && m.text.trim()).slice(-4);
    return '【参照: 会話「' + t.name + '」(' + toolLabel(t) + ' / 作業フォルダ ' + t.cwd + ')】\n'
      + (f ? '全記録: ' + f + ' (詳細が必要なときだけ Read/Grep で読むこと。全文は読み込まない)\n' : '')
      + '直近のやり取り:\n' + ms.map(m => '- ' + (m.role === 'user' ? 'ユーザー' : 'AI') + ': ' + clip(m.text, m.role === 'user' ? 150 : 300)).join('\n') + '\n【参照ここまで】';
  });
}
// チェックポイント: 依頼を送る直前に作業フォルダの状態を記録する(git管理のフォルダだけ。できなくても送信は止めない)
const ckLib = require('./lib/checkpoint'), wtLib = require('./lib/worktree');
const CK_MAX = 60; // 1会話あたりに残す記録の数
const ckTarget = s => { let t = null; for (let i = s.messages.length - 1; i >= 0; i--) { const m = s.messages[i]; if (m.role !== 'user' || m.ck) break; t = m; } return t; }; // 直前に増えた、記録のない発言(連続していれば最初のもの)
async function takeCheckpoint(s) {
  const t = ckTarget(s), dir = effCwd(s);
  if (!t || !dir) return;
  const r = await ckLib.take(dir, s.id + '-' + t.id, t.text);
  if (!r.commit) return;
  t.ck = r.commit; save(); broadcast({ type: 'ck', sid: s.id, mid: t.id });
  ckLib.prune(dir, s.id + '-', CK_MAX).catch(() => {});
}
function send(s, text, images) {
  const go = () => {
    s._ck = false;
    text = expandRefs(text);
    const w = withImages(text, images);
    if (s.tool === 'ext') return sendExt(s, text, images);
    if (s.tool === 'claude') sendClaude(s, w.text); else sendCodex(s, w.text, w.files);
  };
  if (prefs.checkpoint === false) return go();
  s._ck = true; // 記録中に別の送信が割り込まないよう、実行中と同じ扱いにする
  takeCheckpoint(s).catch(() => {}).then(go).catch(e => { s._ck = false; try { if (s.running) setRunning(s, false); addMsg(s, 'sys', '送信に失敗しました: ' + e.message); } catch {} });
}

// 使っていない常駐プロセスを片付ける。常駐1本≒250MB。メモリモード(data/prefs.json): normal=30分 / low=2分 / min=15秒
// バックグラウンド作業中(_bgN>0)は壊さないよう3時間まで残す。次の送信時は --resume で自動的に再起動する(初回だけ少し遅い)
// 使えるAI/機能の検出(where で実行ファイルがあるか)。設定が「自動」なら、無いものは画面に出さない
const TOOL_NAMES = ['claude', 'codex', 'git'];
let toolDet = { t: 0, v: {} };
function toolsInfo() {
  if (!toolDet.t) { // 初回だけ待って調べる
    const v = {};
    for (const k of TOOL_NAMES) { try { execSync('where ' + k, { stdio: 'ignore', windowsHide: true }); v[k] = true; } catch { v[k] = false; } }
    toolDet = { t: Date.now(), v };
  } else if (Date.now() - toolDet.t > 30000 && !toolDet.busy) { // 以降は古い結果を返しつつ、裏で調べ直す(execSyncで全体が止まるのを避ける)
    toolDet.busy = true; const v = {}; let n = 0;
    for (const k of TOOL_NAMES) execFile('where', [k], { windowsHide: true }, err => { v[k] = !err; if (++n === TOOL_NAMES.length) toolDet = { t: Date.now(), v }; });
  }
  const o = {};
  for (const k of TOOL_NAMES) { const mode = ((prefs.tools || {})[k]) || 'auto', installed = !!toolDet.v[k]; o[k] = { mode, installed, show: mode === 'on' || (mode === 'auto' && installed) }; }
  return o;
}
const PREFS = path.join(__dirname, 'data', 'prefs.json');
let prefs = { memMode: 'normal', tools: {}, mcpAsk: true, autoColor: true, checkpoint: true }; try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS, 'utf8')) }; } catch {}
const IDLE_MS = { normal: 30 * 60e3, low: 2 * 60e3, min: 15e3 };
function freeIdle(all) {
  let n = 0;
  for (const [sid, p] of procs) {
    const s = find(sid);
    if (!s || !p.persistent || s.running) continue;
    const lim = (s._bgN || 0) > 0 ? 3 * 3600e3 : (all ? 0 : IDLE_MS[prefs.memMode] || IDLE_MS.normal);
    if (Date.now() - (s.updatedAt || 0) > lim) { p.replaced = true; killTree(p); procs.delete(sid); n++; }
  }
  return n;
}
setInterval(() => freeIdle(false), 15000);

// 用語集: data/glossary.txt の各行 "TBH = TaskBarHero = タスクバーヒーロー" は同じ意味として扱う
const GLOSSARY = path.join(__dirname, 'data', 'glossary.txt');
function readGlossary() {
  try {
    return fs.readFileSync(GLOSSARY, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=').map(t => t.trim()).filter(Boolean)).filter(a => a.length >= 2);
  } catch { return []; }
}
if (!fs.existsSync(GLOSSARY)) {
  try {
    fs.writeFileSync(GLOSSARY, '# 同じ意味の言葉を = でつなぐ(AI検索が略語を理解するための辞書)。1行1グループ。\nTBH = TaskBarHero = Task Bar Hero = タスクバーヒーロー = タスクバーヒーロ\nLoL = League of Legends = リーグオブレジェンド\n');
  } catch {}
}

// 1回だけAIに質問して答えを文字列で返す(ツールなし・セッションを残さない)
function askOnce(tool, prompt) {
  return new Promise((resolve, reject) => {
    const args = tool === 'claude'
      ? ['-p', '--output-format', 'text', '--no-session-persistence', '--tools', '""']
      : ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-'];
    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(tool, args, { cwd: require('os').tmpdir(), shell: true, windowsHide: true, env });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { killTree(child); finish(new Error('時間切れ(3分)')); }, 180000);
    const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => finish(e));
    child.on('close', code => {
      if (tool === 'codex') {
        let text = '';
        for (const l of out.split('\n')) {
          try { const ev = JSON.parse(l); if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') text += ev.item.text + '\n'; } catch {}
        }
        out = text;
      }
      if (code !== 0 && !out.trim()) finish(new Error(`終了コード ${code} ${err.trim().slice(-300)}`));
      else finish(null, out);
    });
  });
}

// JSONの本文を読む。上限を超えたら 413 で失敗(認証前のログインでもメモリを食われないようにする)
async function body(req, max = 2 * 1024 * 1024) {
  const b = await httpLib.readBody(req, max);
  try { return JSON.parse(b || '{}'); } catch { return {}; }
}
// 生のファイルをそのまま保存する(JSON/base64だと大きいファイルが重い)。先頭バイトが宣言どおりの形式かも確認する
function receiveFile(req, res, { dir, name, max, magic, tooBig, extra }) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name), tmp = f + '.part';
  return new Promise(done => {
    const ws = fs.createWriteStream(tmp); let size = 0, head = Buffer.alloc(0), over = false, fin = false;
    const end = (msg, code, ok) => { if (fin) return; fin = true; if (!ok) { try { ws.destroy(); } catch {} fs.unlink(tmp, () => {}); } if (ok) json(res, ok); else json(res, { error: msg }, code); done(); };
    req.pipe(ws);
    req.on('data', d => { size += d.length; if (head.length < 16) head = Buffer.concat([head, d.subarray(0, 16 - head.length)]); if (size > max && !over) { over = true; req.unpipe(ws); } });
    req.on('end', () => { if (over) end(tooBig, 413); });
    req.on('error', () => end('受信に失敗しました', 400));
    req.on('aborted', () => end('受信が途中で切れました', 400));
    ws.on('error', () => end('保存に失敗しました', 500));
    ws.on('finish', () => {
      if (fin) return;
      if (!magic(head)) return end('ファイルの中身が宣言された形式ではありません', 400);
      try { fs.renameSync(tmp, f); } catch { return end('保存に失敗しました', 500); }
      end('', 0, { name, size, ...extra });
    });
  });
}
// ブラウザは必ず Sec-Fetch-Site を付ける。curl や AI が内部APIを直接叩いたときは付かない(確認ダイアログの素通りを防ぐ)
// HTTPのTailscale接続(信頼できるURLではない)ではブラウザが Sec-Fetch-Site を付けないので、その場合は Origin が自分自身と一致することで代える
const fromUi = req => { const sf = req.headers['sec-fetch-site']; return sf ? sf === 'same-origin' : (!!req.headers.origin && req.headers.origin === 'http://' + req.headers.host); };
const pipeFile = (res, st) => { st.on('error', () => res.destroy()); return st.pipe(res); };
const uiOnly = (req, res) => { if (fromUi(req)) return false; json(res, { error: 'この操作は画面のボタンからだけ実行できます(確認なしの直接呼び出しは拒否します)' }, 403); return true; };
const json = (res, obj, code = 200) => {
  const z = httpLib.compressDynamic(Buffer.from(JSON.stringify(obj)), res.req && res.req.headers['accept-encoding']);
  const h = { 'content-type': 'application/json; charset=utf-8' };
  if (z.enc) { h['content-encoding'] = z.enc; h.vary = 'accept-encoding'; }
  res.writeHead(code, h); res.end(z.buf);
};

// ---- スマホ等からの接続(Tailscale経由)用: 合言葉認証 ----
const AUTHF = path.join(__dirname, 'data', 'auth.json');
let AUTH = null;
try { AUTH = JSON.parse(fs.readFileSync(AUTHF, 'utf8')); } catch {}
if (!AUTH || !AUTH.password || !AUTH.secret) {
  AUTH = { password: crypto.randomBytes(9).toString('base64url'), secret: crypto.randomBytes(24).toString('hex') };
  try { fs.writeFileSync(AUTHF, JSON.stringify(AUTH, null, 1)); } catch {}
}
const sec = require('./lib/security');
const PLUGDIR = path.join(__dirname, 'plugins');
const plugins = require('./lib/plugins').make(PLUGDIR, path.join(__dirname, 'data', 'plugins.json'));
// プロンプトの予約実行: 実行中の会話にはぶつけず見送る(次の時刻/間隔でまた試す)
const sched = require('./lib/scheduler').make(path.join(__dirname, 'data', 'schedules.json'), async x => {
  const s = find(x.sid);
  if (!s) { sched.forget(x.sid); return '会話が見つからないため予約を削除しました'; }
  if (s.running) return '実行中だったので見送りました';
  addMsg(s, 'user', '⏰ ' + x.prompt); send(s, x.prompt);
  return '送信しました';
});
setInterval(() => { sched.tick().catch(() => {}); }, 20000).unref();
const termLib = require('./lib/term');
process.on('exit', () => termLib.closeAll());
const authToken = () => sec.authToken(AUTH);
const safeEq = sec.safeEq;
const isLocal = req => sec.isLocalAddr(req.socket.remoteAddress);
const cookieOf = (req, k) => sec.cookieOf(req.headers.cookie, k);
const limiter = new sec.LoginLimiter();
const LOGIN_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatDango</title><style>body{font-family:sans-serif;background:#7494c0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{background:#fff;padding:24px;border-radius:12px;width:min(340px,90vw)}input,button{width:100%;font-size:16px;padding:10px;margin-top:10px;box-sizing:border-box}button{background:#06c755;color:#fff;border:0;border-radius:8px}#e{color:#d33;font-size:13px;min-height:1.2em}</style></head><body><form id="f"><b>ChatDango</b><input id="p" type="password" placeholder="合言葉" autocomplete="current-password"><div id="e"></div><button>入る</button></form><script>document.getElementById("f").onsubmit=async e=>{e.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});if(r.ok)location.reload();else document.getElementById("e").textContent=(await r.json().catch(()=>({}))).error||"失敗しました"}</script></body></html>';
function tailscaleIp() { return sec.tailscaleIp(require('os').networkInterfaces()); }

process.on('unhandledRejection', e => console.error('未処理のエラー:', e && e.message || e));
const server = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const p = u.pathname;
  // 他サイトの枠に埋め込まれる(クリックジャッキング)・形式の取り違え・外部への通信を、ブラウザ側でも止める
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
  try {
    // 他サイトからの操作(CSRF/DNSリバインディング)を拒否: Hostがローカル、書き込み系はOriginもローカルのみ
    const host = req.headers.host || '';
    const local = isLocal(req);
    const hostOk = sec.hostAllowed(host, local, PORT);
    if (!hostOk) { res.writeHead(403); return res.end(); }
    if (!sec.originAllowed(req.method, req.headers.origin, host)) { res.writeHead(403); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); return res.end(); } // Originが無くても、ブラウザが他サイトと申告した書き込みは断る
    if (!local) {
      const ip = req.socket.remoteAddress || '?';
      if (req.method === 'POST' && p === '/api/login') {
        if (limiter.locked(ip)) return json(res, { error: 'しばらく待ってからやり直してください' }, 429);
        const b = await body(req, 4096);
        if (safeEq(b.password || '', AUTH.password)) {
          limiter.ok(ip);
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'cc_auth=' + authToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000' });
          return res.end('{"ok":true}');
        }
        limiter.fail(ip);
        return json(res, { error: '合言葉が違います' }, 401);
      }
      if (!safeEq(cookieOf(req, 'cc_auth'), authToken())) {
        if (req.method === 'GET' && !p.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML); }
        return json(res, { error: '認証が必要です' }, 401);
      }
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/term/status') return json(res, { available: termLib.available(), local, list: termLib.available() && local ? termLib.list() : [] });
    if (p.startsWith('/api/term/')) { // ブラウザ内ターミナル: PC本体(ローカル)の画面からだけ。任意コード実行の入口なので他の端末には開けない
      if (!local) return json(res, { error: 'ターミナルはPC本体の画面からだけ使えます' }, 403);
      if (!termLib.available()) return json(res, { error: 'ターミナル部品(vendor/node-pty)が入っていません' }, 404);
      let tm;
      if (req.method === 'POST' && p === '/api/term/open') {
        if (uiOnly(req, res)) return;
        const b = await body(req, 4096), s = b.sid && find(b.sid);
        let cwd = (s && effCwd(s)) || require('os').homedir(); try { if (!fs.statSync(cwd).isDirectory()) cwd = require('os').homedir(); } catch { cwd = require('os').homedir(); }
        try { return json(res, { id: termLib.open({ cwd, cols: b.cols, rows: b.rows }), cwd }); } catch (e) { return json(res, { error: String(e.message || e) }, 500); }
      }
      if (req.method === 'GET' && (tm = p.match(/^\/api\/term\/([\w-]+)\/stream$/))) { if (!termLib.attach(tm[1], res)) return json(res, { error: 'not found' }, 404); return; }
      if (req.method === 'POST' && (tm = p.match(/^\/api\/term\/([\w-]+)\/(input|resize|close)$/))) {
        if (uiOnly(req, res)) return;
        const b = await body(req, 131072);
        const ok = tm[2] === 'input' ? termLib.input(tm[1], b.d) : tm[2] === 'resize' ? termLib.resize(tm[1], b.cols, b.rows) : termLib.close(tm[1]);
        return json(res, { ok }, ok ? 200 : 404);
      }
    }
    if (req.method === 'GET' && p === '/api/plugins') return json(res, { local, plugins: plugins.list().filter(x => local || x.enabled) });
    if (req.method === 'POST' && p === '/api/plugins/toggle') { // 有効/無効の切り替えはPC本体の画面のボタンからだけ
      if (!local) return json(res, { error: 'プラグインの切り替えはPC本体の画面からだけできます' }, 403);
      if (uiOnly(req, res)) return;
      const b = await body(req, 1024); return json(res, { ok: plugins.setEnabled(b.id, !!b.on) });
    }
    if (p === '/api/schedules' || p.startsWith('/api/schedules/')) { // 予約実行: PC本体の画面からだけ(自動で会話に指示を送る機能なので)
      if (!local) return json(res, { error: '予約はPC本体の画面からだけ操作できます' }, 403);
      let sm;
      if (req.method === 'GET' && p === '/api/schedules') return json(res, { items: sched.list().map(x => ({ ...x, name: (find(x.sid) || {}).name || '(削除された会話)' })) });
      if (req.method === 'POST') {
        if (uiOnly(req, res)) return;
        const b = await body(req, 16384);
        if (p === '/api/schedules') { if (!find(b.sid)) return json(res, { error: '会話が見つかりません' }, 404); return json(res, sched.add(b)); }
        if ((sm = p.match(/^\/api\/schedules\/([\w-]+)\/(toggle|delete|run)$/))) {
          if (sm[2] === 'run') return json(res, { ok: await sched.run(sm[1]) });
          return json(res, { ok: sm[2] === 'delete' ? sched.remove(sm[1]) : sched.toggle(sm[1], b.on) });
        }
      }
    }
    let fm;
    if ((fm = p.match(/^\/api\/sessions\/([\w-]+)\/files$/))) { // 作業フォルダ内のファイル閲覧・編集: PC本体の画面からだけ
      if (!local) return json(res, { error: 'ファイル編集はPC本体の画面からだけ使えます' }, 403);
      const s = find(fm[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const root = effCwd(s);
      if (!root || !fs.existsSync(root) || isRootDir(root)) return json(res, { error: '作業フォルダが未設定か、ホーム/ドライブ直下のため開けません' }, 400);
      const fl = require('./lib/files'), sp = new URL(req.url, 'http://x').searchParams;
      if (req.method === 'GET' && sp.get('stats')) return json(res, { root, ...fl.stats(root) });
      if (req.method === 'GET') return json(res, sp.get('read') ? fl.read(root, sp.get('path')) : { root, ...fl.list(root, sp.get('path')) });
      if (req.method === 'POST') { if (uiOnly(req, res)) return; const b = await body(req, 3 * 1024 * 1024); return json(res, fl.write(root, b.path, b.content, b.base)); }
    }
    if (await connApi(req, res, p, local)) return;
    if (req.method === 'GET' && p === '/api/models') return json(res, { claude: CLAUDE_MODELS, codex: codexModels(), codexDefault: codexDefault() });
    if (req.method === 'GET' && p === '/api/limits') return json(res, limits());
    if (req.method === 'GET' && p === '/api/sessions')
      return json(res, sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(summary));
    if (req.method === 'GET' && p === '/api/search') { // 全会話の本文検索
      const sp = new URL(req.url, 'http://x').searchParams, tool = sp.get('tool') || '';
      return json(res, require('./lib/msgsearch').search(tool ? sessions.filter(s => s.tool === tool) : sessions, (sp.get('q') || '').slice(0, 200)));
    }
    let m;
    // チェックポイント: 発言(または「戻した」通知)に付いた記録の状態へ、作業フォルダを戻す
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/restore$/))) { // 戻したときに変わるファイルの一覧(確認用・読み取りのみ)
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const x = s.messages.find(y => y.id === new URL(req.url, 'http://x').searchParams.get('mid') && y.ck);
      if (!x) return json(res, { error: 'この発言にはチェックポイントがありません' }, 404);
      return json(res, await ckLib.preview(effCwd(s), x.ck));
    }
    if (req.method === 'POST' && /^\/api\/sessions\/[\w-]+\/(restore|wt)$/.test(p) && uiOnly(req, res)) return;
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/restore$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      if (s.running || s._ck) return json(res, { error: '実行中です。止めてから戻してください' }, 409);
      const b = await body(req), x = s.messages.find(y => y.id === String(b.mid) && y.ck);
      if (!x) return json(res, { error: 'この発言にはチェックポイントがありません' }, 404);
      const r = await ckLib.restore(effCwd(s), x.ck, s.id + '-' + x.id);
      if (r.error) return json(res, { error: r.error }, 400);
      addMsg(s, 'sys', '↶ ' + (x.role === 'user' ? '「' + clip(x.text, 30) + '」を送る前' : 'この前') + 'の状態へ、ファイルを戻しました(変更を元に戻したファイル ' + r.restored + ' 件、あとから作られたため削除したファイル ' + r.removed + ' 件)。AIは戻したことを知りません。続けるときは「ファイルを元に戻した」と伝えてください。', null, { ck: r.undo, undo: true });
      return json(res, { ok: true, restored: r.restored, removed: r.removed });
    }
    // worktree分離: 状態の確認、本体への取り込み、片付け
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/wt$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, s.wt ? { wt: true, ...(await wtLib.status(s.wt)), path: s.wt.path, base: s.wt.base } : { wt: false });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/wt$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      if (!s.wt) return json(res, { error: 'この会話は分離して作業していません' }, 400);
      if (s.running || s._ck) return json(res, { error: '実行中です。終わってから操作してください' }, 409);
      const act = String((await body(req)).action || '');
      if (!['merge', 'finish', 'discard'].includes(act)) return json(res, { error: '不明な操作' }, 400);
      const detach = async force => { // 作業用フォルダを消して、会話を本体フォルダへ戻す(AIの記憶は新しくなる)
        const c = procs.get(s.id); if (c) { c.replaced = true; killTree(c); procs.delete(s.id); }
        await ckLib.drop(s.wt.base, s.id + '-').catch(() => {});
        const rm = await wtLib.remove(s.wt, force); if (rm.error) return rm;
        s.cwd = s.wt.base; delete s.wt; s.nativeId = null; if (s.tool === 'ext') s.native = {}; return rm;
      };
      let msg;
      if (act === 'discard') {
        const rm = await detach(true); if (rm.error) return json(res, { error: rm.error }, 400);
        msg = '作業用フォルダとブランチを破棄しました。会話は本体フォルダに戻りました(AIの記憶は新しくなります)。';
      } else {
        const r = await wtLib.merge(s.wt, s.name);
        if (!r.ok) return json(res, { error: r.error, conflicts: r.conflicts || [] }, 409);
        msg = '✔ ' + r.message + '。';
        if (act === 'finish') { const rm = await detach(false); if (rm.error) return json(res, { error: rm.error }, 400); msg += '作業用フォルダを片付け、会話は本体フォルダに戻りました(AIの記憶は新しくなります)。'; }
      }
      addMsg(s, 'sys', msg); save(); broadcast({ type: 'state', sid: s.id, summary: summary(s) });
      return json(res, { ok: true, message: msg });
    }
    if ((req.method === 'GET' || req.method === 'POST') && (m = p.match(/^\/api\/sessions\/([\w-]+)\/git$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, await require('./git-ops').handle(req.method, effCwd(s), req.method === 'POST' ? await body(req) : {}));
    }
    if (req.method === 'GET' && p === '/api/fs') { // フォルダ選択用: 空=ドライブ一覧、パス指定=その中のフォルダ一覧(読み取りのみ)
      let q = (new URL(req.url, 'http://x').searchParams.get('p') || '').trim();
      if (!q) { const dirs = []; for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) dirs.push(d); } catch {} } return json(res, { path: '', dirs }); }
      q = path.resolve(q);
      try {
        if (!fs.statSync(q).isDirectory()) throw 0;
        const dirs = fs.readdirSync(q, { withFileTypes: true }).filter(e => { try { return e.isDirectory() && !/^(\$|System Volume Information$)/.test(e.name); } catch { return false; } }).map(e => e.name).sort((a, b) => a.localeCompare(b, 'ja'));
        return json(res, { path: q, dirs });
      } catch { return json(res, { error: 'フォルダを開けません' }, 400); }
    }
    if (req.method === 'POST' && p === '/api/fs/mkdir') {
      const b = await body(req), name = String(b.name || '').trim();
      if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return json(res, { error: 'フォルダ名に使えない文字が含まれています' }, 400);
      try { const d = path.join(path.resolve(String(b.parent || '')), name); fs.mkdirSync(d, { recursive: false }); return json(res, { path: d }); }
      catch (e) { return json(res, { error: e.code === 'EEXIST' ? 'すでに存在します' : '作成できません' }, 400); }
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/pin$/))) { // 会話のピン留め / メッセージのピン留め(mid指定)
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const b = await body(req);
      if (b.mid) {
        const x = s.messages.find(y => y.id === String(b.mid)); if (!x) return json(res, { error: 'not found' }, 404);
        if (b.pinned) x.pin = true; else delete x.pin;
        save(); return json(res, { ok: true });
      }
      if (b.done !== undefined) s.done = !!b.done; else s.pinned = !!b.pinned; save(); broadcast({ type: 'state', sid: s.id, summary: summary(s) });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/memo$/))) { // 会話ごとのメモ帳(自由な文章1枚。AIには送らない)
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const b = await body(req), t = String(b.text == null ? '' : b.text).slice(0, 100000);
      if (t) s.memo = t; else delete s.memo;
      save(); broadcast({ type: 'memo', sid: s.id, memo: t, from: String(b.from || '').slice(0, 40) });
      return json(res, { ok: true });
    }
    if (p === '/api/groups' && (req.method === 'GET' || req.method === 'POST')) { // グループ一覧(順序・アイコン・色。空グループも保持) data/groups.json
      const GF = path.join(__dirname, 'data', 'groups.json');
      let gl = [], meta = {}; try { const j = JSON.parse(fs.readFileSync(GF, 'utf8')); if (Array.isArray(j)) gl = j; else { gl = j.list || []; meta = j.meta || {}; } } catch {}
      const nm = v => String(v || '').trim().slice(0, 30);
      if (req.method === 'POST') {
        const b = await body(req);
        if (b.add && nm(b.add) && !gl.includes(nm(b.add))) gl.push(nm(b.add));
        if (b.remove) { const r = nm(b.remove); gl = gl.filter(x => x !== r); delete meta[r]; for (const s of sessions) if (s.group === r) s.group = ''; save(); }
        if (b.rename && nm(b.rename.to)) {
          const f = nm(b.rename.from), t = nm(b.rename.to);
          gl = [...new Set(gl.map(x => x === f ? t : x))]; if (meta[f]) { meta[t] = meta[f]; delete meta[f]; }
          for (const s of sessions) if (s.group === f) s.group = t;
          save();
        }
        if (b.meta && nm(b.meta.name)) { const k = nm(b.meta.name), o = meta[k] || {}; if (b.meta.icon !== undefined) { const ic = icons.resolve(b.meta.icon); if (ic !== null) o.icon = validIcon(ic); } if (b.meta.bg !== undefined) o.bg = /^#[0-9a-f]{6}$/i.test(b.meta.bg) ? b.meta.bg : ''; if (b.meta.pinned !== undefined) o.pinned = !!b.meta.pinned; if (b.meta.color !== undefined) o.color = /^#[0-9a-f]{6}$/i.test(b.meta.color) ? b.meta.color : ''; meta[k] = o; if (!gl.includes(k)) gl.push(k); }
        if (Array.isArray(b.order)) { const o = b.order.map(nm).filter(Boolean); gl = [...new Set([...o, ...gl])]; }
        fs.writeFileSync(GF, JSON.stringify({ list: gl, meta }));
      }
      const all = [...new Set([...gl, ...sessions.map(s => s.group).filter(Boolean)])];
      const outMeta = {}; for (const k in meta) outMeta[k] = meta[k] && meta[k].icon ? { ...meta[k], icon: icons.urlOf(meta[k].icon) } : meta[k];
      return json(res, { groups: all, meta: outMeta });
    }
    if (req.method === 'POST' && p === '/api/icon-gen') { // AIアイコン生成: Codexの画像生成で1枚作って dataURL で返す(縮小はクライアント側)
      if (iconBusy >= 2) return json(res, { error: '生成中のアイコンが多すぎます。少し待ってください' }, 429);
      const b = await body(req), name = String(b.name || '').trim().slice(0, 60), hint = String(b.hint || '').trim().slice(0, 200);
      if (!name) return json(res, { error: '名前がありません' }, 400);
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'icongen-'));
      const prompt = `画像生成ツールで、アプリのアイコン用の画像を1枚だけ生成してください。
- テーマ: 「${name}」という名前のチャット/フォルダ用のアイコン${hint ? '。イメージの指定: ' + hint : '。名前から内容を連想できるモチーフにする'}
- 正方形、フラットで太い輪郭線、鮮やかな単色背景、中央に大きく1つのモチーフだけ(細かい装飾は入れない。小さく表示されても分かる単純さ)、文字は一切入れない
生成した画像ファイルを、カレントディレクトリに icon.png という名前でコピーしてください。完了したらファイル名だけ答えてください。`;
      iconBusy++;
      let done = false;
      const fin = (code, out) => { if (done) return; done = true; iconBusy--; try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} json(res, out, code); };
      const child = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-'], { cwd: dir, shell: true, windowsHide: true, env: childEnv() });
      const timer = setTimeout(() => { killTree(child); fin(504, { error: '生成がタイムアウトしました(5分)' }); }, 300000);
      child.stdin.end(prompt); child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
      child.on('error', e => { clearTimeout(timer); fin(500, { error: '起動失敗: ' + e.message }); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const f = fs.readdirSync(dir).find(x => /\.png$/i.test(x));
          if (!f) return fin(500, { error: '画像が生成されませんでした(Codexの画像生成が使えない可能性)' });
          const buf = fs.readFileSync(path.join(dir, f));
          if (buf.length > 12 * 1024 * 1024) return fin(500, { error: '生成画像が大きすぎます' });
          fin(200, { dataUrl: 'data:image/png;base64,' + buf.toString('base64') });
        } catch (e) { fin(500, { error: e.message }); }
      });
      return;
    }
    // スキルの一覧(Claude Code / Codex のどちらで使えるかのタグつき)と、もう一方のツールへのコピー(画面専用)
    if (p === '/api/skills' || p === '/api/skills/copy' || p === '/api/skills/update' || p === '/api/skills/source') {
      if (!local) return json(res, { error: 'forbidden' }, 403);
      if (uiOnly(req, res)) return;
      const home = require('os').homedir();
      const cwdOf = sid => { const s = sessions.find(x => x.id === sid); return s && s.cwd && fs.existsSync(s.cwd) ? path.resolve(s.cwd) : ''; };
      if (p === '/api/skills' && req.method === 'GET') {
        const cwd = cwdOf(new URL(req.url, 'http://x').searchParams.get('sid'));
        const ents = skillsLib.scan(home, cwd);
        // このアプリに同梱の yomiyasu は、どのチャットにも入れていなくても一覧に出す
        const ys = yySrc(), ym = skillsLib.parseMeta((() => { try { return fs.readFileSync(path.join(ys, 'SKILL.md'), 'utf8'); } catch { return ''; } })());
        if (ym.name) for (const tool of ['claude', 'codex']) ents.push({ name: 'yomiyasu', dirName: 'yomiyasu', desc: String(ym.description || '').slice(0, 300), version: yy.versionOf(ys), tool, scope: 'bundled', dir: ys, link: false });
        const groups = skillsLib.group(ents);
        for (const g of groups) {
          for (const pl of g.places) pl.src = pl.scope === 'bundled' ? { kind: 'release', repo: yy.REPO, url: 'https://github.com/' + yy.REPO, tag: 'v' + pl.version } : srcLib.readSource(pl.dir);
          const s0 = g.places.map(x => x.src).find(Boolean); g.src = s0 || null;
          g.version = (g.places.find(x => x.version) || {}).version || '';
          // 入れた日 = フォルダの作成日時(いちばん古いもの)。更新した日 = 更新ボタンで入れ替えた記録、なければ SKILL.md の更新日時
          const st = f => { try { return fs.statSync(f); } catch { return null; } };
          const bt = g.places.map(x => st(x.dir)).filter(Boolean).map(x => (x.birthtimeMs > 0 ? Math.min(x.birthtimeMs, x.mtimeMs) : x.mtimeMs));
          g.installedAt = bt.length ? new Date(Math.min(...bt)).toISOString() : '';
          const um = g.places.map(x => st(path.join(x.dir, 'SKILL.md'))).filter(Boolean).map(x => x.mtimeMs);
          g.updatedAt = (g.places.map(x => x.src && x.src.updatedAt).filter(Boolean).sort().pop()) || (um.length ? new Date(Math.max(...um)).toISOString() : '');
          g.updatedBy = g.places.some(x => x.src && x.src.updatedAt) ? 'button' : 'file';
        }
        return json(res, { skills: groups, cwd });
      }
      if (p === '/api/skills/source' && req.method === 'POST') {
        const b = await body(req), cwd = cwdOf(b.sid), repo = srcLib.parseRepo(b.url);
        if (!repo) return json(res, { error: 'GitHubのURLを入れてください(例: https://github.com/所有者/リポジトリ)' }, 400);
        const places = skillsLib.scan(home, cwd).filter(x => x.name.toLowerCase() === String(b.name).toLowerCase());
        if (!places.length) return json(res, { error: 'スキルが見つかりません' }, 404);
        for (const x of places) { try { srcLib.writeSource(x.dir, repo, ''); } catch {} }
        return json(res, { ok: true, repo, n: places.length });
      }
      if (p === '/api/skills/update' && req.method === 'POST') {
        const b = await body(req), cwd = cwdOf(b.sid), want = String(b.name || '').toLowerCase();
        const places = skillsLib.scan(home, cwd).filter(x => x.name.toLowerCase() === want).map(x => ({ x, src: srcLib.readSource(x.dir) }));
        if (want === 'yomiyasu' && !places.some(p2 => p2.src && p2.src.kind === 'release')) places.push({ x: null, src: { kind: 'release', repo: yy.REPO } });
        if (!places.some(p2 => p2.src)) return json(res, { error: '取得元が分からないため更新できません(先に「取得元を設定」してください)' }, 409);
        const out = { updated: 0, same: 0, errors: [], backups: [] }; let yyDone = false;
        for (const { x, src } of places) {
          if (!src) continue;
          try {
            if (src.kind === 'release') { if (src.repo !== yy.REPO || yyDone) continue; yyDone = true; const r = await updateYomiyasu(); r.updated ? out.updated += r.updated : out.same++; out.version = r.current; }
            else if (src.kind === 'git') { const r = await srcLib.pullGit(x.dir); r.same ? out.same++ : out.updated++; }
            else { const r = await srcLib.updateFromGithub(x.dir, x.name, src.repo, src.sha, path.join(__dirname, 'data', 'skill-backups')); if (r.same) out.same++; else { out.updated++; out.backups.push(r.backup); } }
          } catch (e) { out.errors.push(String(e.message || e)); }
        }
        return json(res, out.errors.length && !out.updated && !out.same ? { error: out.errors[0] } : { ok: true, ...out }, out.errors.length && !out.updated && !out.same ? 502 : 200);
      }
      if (p === '/api/skills/copy' && req.method === 'POST') {
        const b = await body(req), cwd = cwdOf(b.sid);
        if (b.to !== 'claude' && b.to !== 'codex') return json(res, { error: 'コピー先が不正です' }, 400);
        // 一覧にある物だけ(名前・置き場所・範囲で特定する)。コピー元のパスは画面から受け取らない
        const src = skillsLib.scan(home, cwd).find(x => x.name === b.name && x.tool !== b.to && x.scope === b.scope);
        if (!src) return json(res, { error: 'コピー元のスキルが見つかりません' }, 404);
        const r = skillsLib.copySkill(src, home, cwd, b.to);
        return json(res, r.error ? { error: r.error } : { ok: true, to: r.to }, r.error ? 409 : 200);
      }
      return json(res, { error: 'not found' }, 404);
    }
    // チャットごとのプロセス一覧と停止(画面専用。止められるのは各チャットの子孫プロセスだけ)
    if (p === '/api/tasks' || p === '/api/tasks/stop') {
      if (!local) return json(res, { error: 'forbidden' }, 403);
      if (uiOnly(req, res)) return;
      const roots = () => [...procs].filter(([, c]) => c && c.pid && c.exitCode == null).map(([sid, c]) => ({ sid, pid: c.pid }));
      if (p === '/api/tasks' && req.method === 'GET') {
        if (!tasksBusy) {
          tasksBusy = true;
          try {
            const list = await tasksLib.listProcs(), now = list.at || Date.now();
            if (now === tasksAt) return json(res, { chats: tasksLast });
            const r = tasksLib.summarize(list, roots(), tasksPrev, tasksAt ? (now - tasksAt) / 1000 : 0, require('os').cpus().length, process.pid);
            tasksPrev = r.next; tasksAt = now;
            tasksLast = r.chats.map(c => { const s = sessions.find(x => x.id === c.sid); return { ...c, name: s ? s.name : '(不明)', running: !!(s && s.running) }; });
          } finally { tasksBusy = false; }
        }
        return json(res, { chats: tasksLast });
      }
      if (p === '/api/tasks/stop' && req.method === 'POST') {
        const b = await body(req);
        const root = roots().find(r => r.sid === b.sid);
        const list = await tasksLib.listProcs(true);
        if (!root || !tasksLib.canStop(list, root.pid, b.pid, b.start, process.pid)) return json(res, { error: '止められません(すでに終了したか、このチャットのプロセスではありません)' }, 409);
        const ok = await new Promise(r => require('child_process').execFile('taskkill', ['/pid', String(b.pid), '/T', '/F'], { windowsHide: true }, e => r(!e)));
        return json(res, ok ? { ok: true } : { error: '停止に失敗しました' }, ok ? 200 : 500);
      }
      return json(res, { error: 'not found' }, 404);
    }
    // PC全体のプロセス(タスクマネージャー風)と終了(画面専用)。Windows本体・サーバー自身は止められない
    if (p === '/api/procs' || p === '/api/procs/stop') {
      if (!local) return json(res, { error: 'forbidden' }, 403);
      if (uiOnly(req, res)) return;
      if (p === '/api/procs' && req.method === 'GET') {
        const list = await tasksLib.listProcs();
        if (list.at !== procsAt) {
          const r = tasksLib.groupAll(list, procsPrev, procsAt ? (list.at - procsAt) / 1000 : 0, require('os').cpus().length, process.pid, require('os').totalmem());
          procsPrev = r.next; procsAt = list.at; procsLast = { groups: r.groups, total: r.total };
        }
        return json(res, procsLast);
      }
      if (p === '/api/procs/stop' && req.method === 'POST') {
        const b = await body(req);
        const items = Array.isArray(b.items) ? b.items.slice(0, 500) : [];
        const list = await tasksLib.listProcs(true);
        let ok = 0, skipped = 0;
        for (const it of items) {
          if (!it || !tasksLib.canStopAny(list, it.pid, it.start, process.pid)) { skipped++; continue; }
          if (await new Promise(r => require('child_process').execFile('taskkill', ['/pid', String(it.pid), '/F'], { windowsHide: true }, e => r(!e)))) ok++; else skipped++;
        }
        return json(res, ok ? { ok: true, stopped: ok, skipped } : { error: '止められませんでした(すでに終了したか、止めてはいけないプロセスです)' }, ok ? 200 : 409);
      }
      return json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/prefs' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'POST') {
        const b = await body(req);
        if (IDLE_MS[b.memMode]) { prefs.memMode = b.memMode; fs.writeFileSync(PREFS, JSON.stringify(prefs)); freeIdle(false); }
        if (typeof b.mcpAsk === 'boolean') { prefs.mcpAsk = b.mcpAsk; fs.writeFileSync(PREFS, JSON.stringify(prefs)); }
        if (typeof b.autoColor === 'boolean') { prefs.autoColor = b.autoColor; fs.writeFileSync(PREFS, JSON.stringify(prefs)); }
        if (typeof b.sysstat === 'boolean') { prefs.sysstat = b.sysstat; fs.writeFileSync(PREFS, JSON.stringify(prefs)); }
        if (typeof b.checkpoint === 'boolean') { prefs.checkpoint = b.checkpoint; fs.writeFileSync(PREFS, JSON.stringify(prefs)); }
        if (b.fillColors) { for (const s of sessions) if (!s.color) { s.color = autoColor(); broadcast({ type: 'state', sid: s.id, summary: summary(s) }); } save(); }
        if (b.tools && typeof b.tools === 'object') { // 使うAI/機能の表示設定 {claude|codex|git: auto|on|off}
          prefs.tools = { ...(prefs.tools || {}) };
          for (const k of TOOL_NAMES) if (['auto', 'on', 'off'].includes(b.tools[k])) prefs.tools[k] = b.tools[k];
          fs.writeFileSync(PREFS, JSON.stringify(prefs));
        }
      }
      return json(res, { tools: toolsInfo(), mcpAsk: prefs.mcpAsk !== false, autoColor: prefs.autoColor !== false, checkpoint: prefs.checkpoint !== false, sysstat: prefs.sysstat !== false, mcpRe: MCP_RE.source, memMode: prefs.memMode, resident: [...procs.values()].filter(x => x.persistent).length });
    }
    if (req.method === 'POST' && p === '/api/free-idle') return json(res, { freed: freeIdle(true) });
    if (req.method === 'POST' && p === '/api/order') { // 一覧のドラッグ並べ替え {seq:[{s:id}|{g:name}...表示順], id:動かした会話, group}
      const b = await body(req);
      const GF = path.join(__dirname, 'data', 'groups.json');
      let gl = [], meta = {}; try { const j = JSON.parse(fs.readFileSync(GF, 'utf8')); if (Array.isArray(j)) gl = j; else { gl = j.list || []; meta = j.meta || {}; } } catch {}
      const seq = Array.isArray(b.seq) ? b.seq : [];
      seq.forEach((e, i) => {
        if (e && e.s) { const s = find(String(e.s)); if (s) s.order = i; }
        else if (e && e.g) { const k = String(e.g).trim().slice(0, 30); if (k) { meta[k] = { ...(meta[k] || {}), order: i }; if (!gl.includes(k)) gl.push(k); } }
      });
      const mv = find(String(b.id || '')); if (mv && b.group !== undefined) mv.group = String(b.group).trim().slice(0, 30);
      save(); fs.writeFileSync(GF, JSON.stringify({ list: gl, meta }));
      for (const s of sessions) broadcast({ type: 'state', sid: s.id, summary: summary(s) });
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/export$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const last = Math.min(200, parseInt(new URL(req.url, 'http://x').searchParams.get('last') || '0', 10) || 0);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(transcript(s, last));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/commands$/))) { // 入力欄の「/」候補: カスタムコマンドとスキル(Claudeのみ)
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, { items: s.tool === 'ext' ? [] : slashItems(effCwd(s), s.tool) });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      let idAdded = false; for (const x of s.messages) if (!x.id) { x.id = crypto.randomUUID().slice(0, 8); idAdded = true; } // 旧メッセージにも付与(ピン留め用)
      if (idAdded) save();
      return json(res, { ...summary(s), messages: s.messages, live: s._live || '', draft: s.draft || '', memo: s.memo || '' });
    }
    if (req.method === 'POST' && p === '/api/sessions') {
      const b = await body(req);
      const cwd = (b.cwd || '').trim() || process.env.USERPROFILE;
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return json(res, { error: 'フォルダが存在しません: ' + cwd }, 400);
      const ext = (b.tool && b.tool !== 'claude' && b.tool !== 'codex') ? conns.get(String(b.tool)) : null;
      if (b.tool && b.tool !== 'claude' && b.tool !== 'codex' && (!ext || !ext.enabled)) return json(res, { error: '選んだAI接続が見つからないか、無効です。設定 → AI接続 を確認してください' }, 400);
      const sid = crypto.randomUUID();
      let wt = null; // 分離して作業: 会話専用のフォルダとブランチを作り、AIの作業場所をそこにする
      if (b.worktree) {
        const r = await wtLib.create(cwd, (b.name || '').trim() || 'chat', sid);
        if (!r.wt) return json(res, { error: r.error }, 400);
        wt = r.wt;
      }
      const s = {
        id: sid, name: (b.name || '').trim() || '無題', ...(wt ? { wt } : {}),
        tool: ext ? 'ext' : (b.tool === 'codex' ? 'codex' : 'claude'), ...(ext ? { conn: ext.id, native: {} } : {}), cwd: wt ? wt.path : cwd,
        perm: (b.perm === 'full' && isLocal(req)) ? 'full' : 'safe', color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : (prefs.autoColor !== false ? autoColor() : ''), icon: validIcon(icons.resolve(b.icon) || ''), mcp: validMcp(b.mcp), model: ext ? (validExtModel(b.model) || ext.defaultModel || '') : validModel(b.model), effort: ext ? '' : (validEffort(b.effort) || (b.tool === 'codex' ? '' : 'medium')),
        nativeId: null, messages: [], running: false, createdAt: Date.now(), updatedAt: Date.now(), fmt: b.fmt !== false,
      };
      const note = b.yomiyasu ? installYomiyasu(s) : '';
      sessions.push(s); save();
      broadcast({ type: 'state', sid: s.id, summary: summary(s) });
      return json(res, { ...summary(s), note });
    }
    if (req.method === 'POST' && /^\/api\/sessions\/[\w-]+\/(archive-continue|handoff)$/.test(p) && uiOnly(req, res)) return;
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/archive-continue$/))) { // 引き継ぎ資料を作らせ → gzipアーカイブ → 新しいチャットへ
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      if (s.running) return json(res, { error: '実行中です。終わってから押してください' }, 409);
      s._handoff = true; s._archive = true;
      addMsg(s, 'user', '【アーカイブして新しいチャットへ引き継ぐ: 資料の作成を依頼】');
      send(s, HANDOFF_PROMPT);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/open-folder$/))) { // 作業フォルダをエクスプローラーで開く(サーバーPC上)
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const fc = effCwd(s);
      if (!fc || !fs.existsSync(fc)) return json(res, { error: '作業フォルダが見つかりません: ' + (fc || '(未設定)') }, 404);
      try { const ex = spawn('explorer.exe', [path.resolve(fc)], { detached: true, stdio: 'ignore' }); ex.on('error', () => {}); ex.unref(); } catch (e) { return json(res, { error: e.message }, 500); }
      // 開いた窓が後ろに隠れないよう、窓の名前(フォルダ名)で前面に出す。サーバーは裏で動くため、普通に開くと手前に来ないことがある
      try {
        const ps = '$t=$env:VC_WIN; $w=New-Object -ComObject WScript.Shell; for($i=0;$i -lt 12;$i++){ Start-Sleep -Milliseconds 300; if($w.AppActivate($t)){ break } }';
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, VC_WIN: path.basename(path.resolve(fc)) || fc } }).unref();
      } catch {}
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/repo-name$/))) { // プロジェクトに合ったGitHubリポジトリ名の提案
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const dir = effCwd(s), base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '');
      const ok = n => /^[a-z0-9][a-z0-9._-]{1,38}$/.test(n);
      let hint = '';
      for (const f of ['SPEC.md', 'README.md', 'package.json']) { try { hint += '--- ' + f + '\n' + fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1200) + '\n'; } catch {} }
      let name = '';
      try {
        const ans = await askOnce('claude', 'GitHubのリポジトリ名を1つだけ決めてください。プロジェクトの内容に合った、短い英語のkebab-case(小文字英数字とハイフンのみ、最大30文字)。名前以外は何も出力しないこと。\nフォルダ名: ' + path.basename(dir) + '\n会話名: ' + s.name + '\n' + hint);
        name = (ans.trim().split(/\s+/).pop() || '').replace(/[`'"*]/g, '').toLowerCase();
      } catch {}
      if (!ok(name)) name = ok(base.toLowerCase()) ? base.toLowerCase() : 'project-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return json(res, { name, dir });
    }
    if (req.method === 'GET' && p === '/api/archives') {
      let out = [];
      try {
        out = fs.readdirSync(ARCHIVE).filter(f => f.endsWith('.json.gz')).map(f => {
          const st = fs.statSync(path.join(ARCHIVE, f)), c = arcMeta.get(f);
          if (c && c.at === st.mtimeMs) return c;
          let n = 0, name = f, lineage = '';
          try { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, f)))); n = (j.messages || []).length; name = j.name; lineage = j.lineage || ''; } catch {}
          const r = { file: f, name, lineage, messages: n, kb: Math.round(st.size / 1024), at: st.mtimeMs };
          arcMeta.set(f, r); return r;
        }).sort((a, b) => b.at - a.at);
      } catch {}
      return json(res, out);
    }
    if (req.method === 'POST' && p === '/api/archives/restore') {
      const b = await body(req), f = String(b.file || '');
      if (path.basename(f) !== f || !f.endsWith('.json.gz')) return json(res, { error: '不正なファイル名' }, 400);
      let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, f)))); } catch { return json(res, { error: 'アーカイブを読めません' }, 404); }
      if (find(j.id)) j.id = crypto.randomUUID();
      for (const k of Object.keys(j)) if (k.startsWith('_')) delete j[k];
      j.running = false; j.queue = []; j.nativeId = null; if (j.tool === 'ext') j.native = {}; j.updatedAt = Date.now();
      j.messages = (j.messages || []).concat([{ id: crypto.randomUUID().slice(0, 8), role: 'sys', text: 'アーカイブから復元しました。AIの記憶は空なので、必要なら引き継ぎ資料を作ってください', ts: Date.now() }]);
      sessions.push(j); save();
      try { fs.unlinkSync(path.join(ARCHIVE, f)); } catch {}
      broadcast({ type: 'state', sid: j.id, summary: summary(j) });
      return json(res, { ok: true, id: j.id });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/handoff$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      if (s.running) return json(res, { error: '実行中です。終わってから押してください' }, 409);
      s._handoff = true;
      addMsg(s, 'user', '【引き継ぎ資料の作成を依頼】');
      send(s, HANDOFF_PROMPT);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/(send|stop|rename)$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const b = await body(req);
      if (m[2] === 'send') {
        delete s.draft;
        const images = okImages(b.images);
        let text = String(b.text || '').trim(); if (!text && !images.length) return json(res, { error: '空' }, 400);
        if (!text) text = '(画像を添付します)';
        const live = procs.get(s.id);
        if (s.running && s.tool === 'claude' && live && live.persistent && !live.killed) {
          // ターミナルと同じ: 実行中に送った発言は、その場でAIに届き、進行中のターンに反映される
          addMsg(s, 'user', text, images);
          live.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: withImages(text, images).text } }) + '\n');
          return json(res, { ok: true, steered: true });
        }
        if (s.running || s._ck) { (s.queue = s.queue || []).push({ text, images }); addMsg(s, 'user', text, images); return json(res, { ok: true, queued: true }); }
        addMsg(s, 'user', text, images); send(s, text, images); return json(res, { ok: true });
      }
      if (m[2] === 'stop') {
        const c = procs.get(s.id);
        if (c) { s._stopped = true; c.stopped = true; killTree(c); if (c.forceEnd) setTimeout(c.forceEnd, 2500); } // 殺しても終了の通知が来ない場合は、強制的に終わらせる
        else if (s.running) { s._stopped = true; endTurn(s, 0, ''); } // 実行中の表示だけ残っていて、止める相手がいない(固まった表示を解く)
        return json(res, { ok: true });
      }
      if (m[2] === 'rename') {
        if (b.name && b.name.trim()) s.name = b.name.trim();
        if (b.cwd !== undefined && b.cwd.trim()) {
          if (!fs.existsSync(b.cwd.trim())) return json(res, { error: 'フォルダが存在しません' }, 400);
          const nc = b.cwd.trim();
          if (nc !== s.cwd) { // Claudeの会話は作業フォルダごとに保存されるので、再開できるよう新しいフォルダ側へ複製する
            if (s.tool === 'claude' && s.nativeId) {
              try {
                const enc = p => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-'), root = path.join(require('os').homedir(), '.claude', 'projects');
                const src = path.join(root, enc(s.cwd), s.nativeId + '.jsonl'), dst = path.join(root, enc(nc));
                if (fs.existsSync(src)) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(src, path.join(dst, s.nativeId + '.jsonl')); }
                else s.nativeId = null;
              } catch { s.nativeId = null; }
            }
            const c0 = procs.get(s.id); if (c0 && !s.running) { c0.replaced = true; killTree(c0); procs.delete(s.id); }
          }
          s.cwd = nc;
        }
        if (b.color !== undefined) s.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '';
        if (b.icon !== undefined) { const ic = icons.resolve(b.icon); if (ic !== null) s.icon = validIcon(ic); }
        if (b.bg !== undefined) s.bg = /^#[0-9a-f]{6}$/i.test(b.bg) ? b.bg : '';
        if (b.bgm !== undefined) s.bgm = validBgm(b.bgm);
        if (b.group !== undefined) s.group = String(b.group).trim().slice(0, 30);
        if (b.mcp !== undefined) s.mcp = validMcp(b.mcp);
        if (b.model !== undefined) s.model = s.tool === 'ext' ? validExtModel(b.model) : validModel(b.model);
        if (b.effort !== undefined) s.effort = validEffort(b.effort);
        if (b.perm) s.perm = (b.perm === 'full' && isLocal(req)) ? 'full' : 'safe';
        if (typeof b.fmt === 'boolean') s.fmt = b.fmt;
        const note = b.yomiyasu === true ? installYomiyasu(s) : b.yomiyasu === false ? removeYomiyasu(s) : '';
        save(); broadcast({ type: 'state', sid: s.id, summary: summary(s) });
        return json(res, { ...summary(s), note });
      }
    }
    if (req.method === 'DELETE' && /^\/api\/sessions\/[\w-]+$/.test(p) && uiOnly(req, res)) return;
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
      const s = find(m[1]); if (!s) return json(res, { error: 'not found' }, 404);
      const c = procs.get(s.id); if (c) { c.replaced = true; killTree(c); procs.delete(s.id); }
      let kept = ''; // 分離した作業フォルダ: 取り込んでいない作業があれば残す(消すと失われるため)
      await ckLib.drop(s.wt ? s.wt.base : effCwd(s), s.id + '-').catch(() => {});
      if (s.wt) { const st = await wtLib.status(s.wt); if (st.ok && !st.changed && !st.ahead) await wtLib.remove(s.wt, false); else if (st.ok) kept = s.wt.path; }
      sessions = sessions.filter(x => x !== s); save();
      broadcast({ type: 'deleted', sid: s.id });
      return json(res, { ok: true, kept });
    }
    if (req.method === 'GET' && p === '/api/importable') {
      importCache = importer.list();
      const have = new Set(sessions.map(s => s.nativeId).filter(Boolean));
      return json(res, importCache.filter(i => !have.has(i.nativeId)).map(({ file, ...r }) => r));
    }
    if (req.method === 'POST' && p === '/api/ai-search') {
      const b = await body(req);
      const q = String(b.query || '').trim();
      if (!q) return json(res, { error: '検索ワードが空です' }, 400);
      const engine = b.engine === 'codex' ? 'codex' : 'claude';
      const have = new Set(sessions.map(s => s.nativeId).filter(Boolean));
      const cand = importCache.filter(i => !have.has(i.nativeId) && (!b.tool || i.tool === b.tool));
      if (!cand.length) return json(res, { ids: [], keywords: [] });
      // 1) 用語集で確実に展開(略語 TBH など)  2) AIで同義語・表記ゆれを追加  3) セッション本文を全文検索
      const gloss = readGlossary();
      let kws = q.split(/[\s、,，]+/).filter(Boolean);
      kws.push(q);
      const nq = q.normalize('NFKC').toLowerCase();
      for (const line of gloss) if (line.some(t => nq.includes(t.normalize('NFKC').toLowerCase()))) kws.push(...line);
      let aiNote = '';
      try {
        const prompt = `コーディングAIの過去会話ログを全文検索するためのキーワードを作ります。\n探したい内容: 「${q}」\n` +
          (gloss.length ? `略語・用語集(同じ行は同じ意味):\n${gloss.map(l => l.join(' = ')).join('\n')}\n` : '') +
          `この内容が書かれていそうな会話に出てくる単語を、略語の正式名・英語/日本語/カタカナ表記・関連する固有名詞・ファイル名や英語の識別子まで含めて最大15個(SPEC.md や README のように、どの会話にも出る一般的な語は入れない)、JSONの文字列配列だけで答えてください。説明は不要です。`;
        const text = await askOnce(engine, prompt);
        const m = text.match(/\[[\s\S]*\]/);
        if (m) kws.push(...JSON.parse(m[0]).filter(x => typeof x === 'string'));
        else aiNote = 'AIの返答を読めませんでした(用語集と入力語だけで検索)';
      } catch (e) { aiNote = 'AIが使えませんでした(用語集と入力語だけで検索): ' + e.message.slice(0, 100); }
      kws = [...new Set(kws)];
      const found = importer.search(cand, kws, 20);
      return json(res, { ids: found.map(f => f.nativeId), keywords: kws, note: aiNote });
    }
    if (req.method === 'POST' && p === '/api/import') {
      const b = await body(req);
      const item = importCache.find(i => i.nativeId === b.nativeId && i.tool === b.tool);
      if (!item) return json(res, { error: '一覧にありません。取り込み画面を開き直してください' }, 404);
      if (sessions.some(s => s.nativeId === item.nativeId)) return json(res, { error: '取り込み済みです' }, 409);
      const cwd = item.cwd && fs.existsSync(item.cwd) ? item.cwd : process.env.USERPROFILE;
      const messages = importer.load(item);
      const s = {
        id: crypto.randomUUID(), name: (b.name || '').trim() || item.title.slice(0, 30),
        tool: item.tool, cwd, perm: 'safe', color: prefs.autoColor !== false ? autoColor() : '', nativeId: item.nativeId,
        messages, running: false, createdAt: item.mtime, updatedAt: item.mtime,
      };
      sessions.push(s); save();
      broadcast({ type: 'state', sid: s.id, summary: summary(s) });
      return json(res, summary(s));
    }
    if (req.method === 'GET' && p === '/api/boot') return json(res, { boot: BOOT_ID }); // 再起動を見届ける用(起動のたびに値が変わる)
    if (req.method === 'POST' && p === '/api/restart' && uiOnly(req, res)) return;
    if (req.method === 'POST' && p === '/api/restart') {
      const b = await body(req);
      const busy = sessions.filter(x => x.running).map(x => x.name);
      if (busy.length && !b.force) return json(res, { busy }, 409);
      json(res, { ok: true });
      setTimeout(() => {
        const quit = () => { save(); setTimeout(() => process.exit(0), 300); };
        try {
          if (process.platform === 'win32') { // detachedで直接起動すると黒いコンソール窓が出るため、PowerShell経由で窓なしに起動する。起動の依頼が済んでから終了する(先に終わると依頼ごと消えることがある)
            const q = s => "'" + String(s).replace(/'/g, "''") + "'";
            const ps = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -WindowStyle Hidden -FilePath ' + q(process.execPath) + ' -ArgumentList ' + q('"' + path.join(__dirname, 'server.js') + '"') + ' -WorkingDirectory ' + q(__dirname)], { stdio: 'ignore', windowsHide: true });
            ps.on('error', quit); ps.on('exit', quit); setTimeout(quit, 10000);
            return;
          }
          spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();
        } catch {}
        quit();
      }, 200);
      return;
    }
    // 読み上げ: PC内の VOICEVOX 互換エンジン(127.0.0.1)へ中継するだけ。音声はメモリ上だけで、ファイルには残さない
    // 読み上げエンジンへの接続を使い回す(1塊ごとに接続し直す手間を省く。同時4本まで)
    if (p === '/api/tts/speakers' || p === '/api/tts/speak') {
      if (!local) return json(res, { error: 'forbidden' }, 403);
      if (uiOnly(req, res)) return;
      const q = new URL(req.url, 'http://x').searchParams;
      const b = req.method === 'POST' ? await body(req, 64 * 1024) : {};
      const port = Math.round(Number(b.port || q.get('port') || 50021));
      if (!(port >= 1024 && port <= 65535)) return json(res, { error: 'ポート番号が不正です' }, 400);
      const call = (method, pathq, payload) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: pathq, method, timeout: 30000, agent: ttsAgent, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : { 'content-length': 0 } }, rs => {
          const c = []; let n = 0;
          rs.on('data', d => { n += d.length; if (n > 30 * 1024 * 1024) r.destroy(new Error('too big')); else c.push(d); });
          rs.on('end', () => resolve({ status: rs.statusCode, buf: Buffer.concat(c) }));
        });
        r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
        if (payload) r.write(payload); r.end();
      });
      const down = () => json(res, { error: '読み上げエンジン(VOICEVOX)に接続できません。起動してから、もう一度試してください' }, 502);
      try {
        if (p === '/api/tts/speakers' && req.method === 'GET') {
          const r = await call('GET', '/speakers');
          if (r.status !== 200) return json(res, { error: '話者の一覧を取得できませんでした(' + r.status + ')' }, 502);
          const list = [];
          for (const sp of JSON.parse(r.buf.toString('utf8'))) for (const st of (sp.styles || [])) if (Number.isInteger(st.id)) list.push({ id: st.id, name: String(sp.name).slice(0, 40) + '(' + String(st.name).slice(0, 20) + ')' });
          return json(res, { speakers: list });
        }
        if (p === '/api/tts/speak' && req.method === 'POST') {
          const text = String(b.text || '').slice(0, 400), spk = Number(b.speaker);
          if (!text.trim() || !Number.isInteger(spk) || spk < 0) return json(res, { error: '読み上げる文章か話者が不正です' }, 400);
          const a = await call('POST', '/audio_query?speaker=' + spk + '&text=' + encodeURIComponent(text));
          if (a.status !== 200) return json(res, { error: '読み上げの準備に失敗しました(' + a.status + ')' }, 502);
          const aq = JSON.parse(a.buf.toString('utf8'));
          const sp = Number(b.speed), vl = Number(b.volume);
          if (sp >= 0.5 && sp <= 2) aq.speedScale = sp;
          if (vl > 0 && vl <= 2) aq.volumeScale = vl;
          const w = await call('POST', '/synthesis?speaker=' + spk, JSON.stringify(aq));
          if (w.status !== 200) return json(res, { error: '音声の合成に失敗しました(' + w.status + ')' }, 502);
          res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'content-length': w.buf.length });
          return res.end(w.buf);
        }
      } catch { return down(); }
      return json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/yomiyasu' && req.method === 'GET') {
      const cur = yy.versionOf(yySrc());
      const stale = sessions.filter(s => s.yomiyasu && fs.existsSync(path.join(yyDest(s), 'VENDORED.txt')) && yy.cmpVer(yy.versionOf(yyDest(s)), cur) < 0).length;
      return json(res, { current: cur, bundled: yy.versionOf(YY_BUNDLED), stale, url: 'https://github.com/' + yy.REPO });
    }
    if (p === '/api/yomiyasu/update' && req.method === 'POST') { // 公式リリースの最新版を取り込み、入れてあるコピーも入れ替える(PC本体からのみ)
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      try { return json(res, await updateYomiyasu()); } catch (e) { return json(res, { error: String(e.message || e) }, 502); }
    }
    if (req.method === 'POST' && p === '/api/terminal' && uiOnly(req, res)) return;
    if (req.method === 'POST' && p === '/api/terminal') { // PowerShell/CMDをPC上で起動(PC本体からのみ)。開いている会話の作業フォルダ、なければホーム
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      const b = await body(req); const s = b.sid ? find(b.sid) : null;
      let cwd = s ? effCwd(s) : ''; if (!cwd || !fs.existsSync(cwd)) cwd = require('os').homedir();
      const exe = b.kind === 'cmd' ? 'cmd.exe' : 'powershell.exe', extra = b.kind === 'cmd' ? [] : ['-NoExit'];
      try { spawn('cmd.exe', ['/c', 'start', '', exe, ...extra], { cwd: path.resolve(cwd), detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { return json(res, { error: e.message }, 500); }
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/upload') {
      const b = await body(req, 32 * 1024 * 1024); // 画像20MBのbase64が収まる大きさ
      const mm = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.dataUrl || ''));
      if (!mm) return json(res, { error: '対応していない画像です' }, 400);
      const buf = Buffer.from(mm[2], 'base64');
      if (buf.length > 20 * 1024 * 1024) return json(res, { error: '画像が大きすぎます(20MBまで)' }, 400);
      const name = crypto.randomUUID() + '.' + (mm[1] === 'jpeg' ? 'jpg' : mm[1]);
      fs.writeFileSync(path.join(IMG, name), buf);
      return json(res, { name });
    }
    if (p === '/api/theme-bg' && req.method === 'GET') {
      let list = []; try { list = fs.readdirSync(THEME).filter(n => themeLib.NAME_RE.test(n)).map(n => { const st = fs.statSync(path.join(THEME, n)); return { name: n, size: st.size, mtime: st.mtimeMs, video: /\.(mp4|webm)$/.test(n) }; }).sort((a, b) => b.mtime - a.mtime); } catch {}
      return json(res, list);
    }
    if (p === '/api/theme-bg' && req.method === 'POST') { // 生のファイルをそのまま受け取る(JSON/base64だと動画が重い)。PC本体の画面からだけ
      if (uiOnly(req, res)) return;
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      const ext = themeLib.extOf(req.headers['content-type']);
      if (!ext) return json(res, { error: '対応していない形式です(png / jpg / webp / gif / mp4 / webm)' }, 400);
      if ((+req.headers['content-length'] || 0) > themeLib.MAX_BYTES) return json(res, { error: 'ファイルが大きすぎます(500MBまで)' }, 413);
      return await receiveFile(req, res, { dir: THEME, name: crypto.randomUUID() + '.' + ext, max: themeLib.MAX_BYTES, magic: h => themeLib.magicOk(ext, h), tooBig: 'ファイルが大きすぎます(500MBまで)', extra: { video: /^(mp4|webm)$/.test(ext) } });
    }
    // フォントファイル(data/theme/ に置く。名前は 元の英数字名-乱数.拡張子)
    if (p === '/api/theme-font' && req.method === 'GET') {
      let list = []; try { list = fs.readdirSync(THEME).filter(n => themeLib.FONT_NAME_RE.test(n)).map(n => { const st = fs.statSync(path.join(THEME, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime); } catch {}
      return json(res, list);
    }
    if (p === '/api/theme-font' && req.method === 'POST') {
      if (uiOnly(req, res)) return;
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      const ext = themeLib.fontExtOf(req.headers['content-type']);
      if (!ext) return json(res, { error: '対応していない形式です(ttf / otf / woff / woff2)' }, 400);
      if ((+req.headers['content-length'] || 0) > themeLib.FONT_MAX_BYTES) return json(res, { error: 'フォントが大きすぎます(40MBまで)' }, 413);
      let orig = ''; try { orig = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch {}
      const name = themeLib.fontSlug(orig) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      return await receiveFile(req, res, { dir: THEME, name, max: themeLib.FONT_MAX_BYTES, magic: h => themeLib.fontMagicOk(ext, h), tooBig: 'フォントが大きすぎます(40MBまで)', extra: {} });
    }
    let tm;
    if (req.method === 'DELETE' && (tm = p.match(/^\/api\/theme-font\/([\w-]+\.[a-z0-9]+)$/)) && themeLib.FONT_NAME_RE.test(tm[1])) {
      if (uiOnly(req, res)) return;
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      try { fs.unlinkSync(path.join(THEME, tm[1])); } catch {}
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && (tm = p.match(/^\/theme-font\/([\w-]+\.[a-z0-9]+)$/)) && themeLib.FONT_NAME_RE.test(tm[1])) {
      const f = path.join(THEME, tm[1]); let st; try { st = fs.statSync(f); } catch { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': themeLib.FONT_MIME[tm[1].split('.').pop()], 'content-length': st.size, 'cache-control': 'max-age=31536000, immutable' });
      return pipeFile(res, fs.createReadStream(f));
    }
    if (req.method === 'DELETE' && (tm = p.match(/^\/api\/theme-bg\/([\w-]+\.[a-z0-9]+)$/)) && themeLib.NAME_RE.test(tm[1])) {
      if (uiOnly(req, res)) return;
      if (!isLocal(req)) return json(res, { error: 'この操作はPC本体からのみ可能です' }, 403);
      try { fs.unlinkSync(path.join(THEME, tm[1])); } catch {}
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && (tm = p.match(/^\/theme-bg\/([\w-]+\.[a-z0-9]+)$/)) && themeLib.NAME_RE.test(tm[1])) { // Range対応(動画のループ/シーク)
      const f = path.join(THEME, tm[1]); let st; try { st = fs.statSync(f); } catch { res.writeHead(404); return res.end(); }
      const hd = { 'content-type': themeLib.MIME[tm[1].split('.').pop()], 'accept-ranges': 'bytes', 'cache-control': 'max-age=31536000' };
      const r = themeLib.parseRange(req.headers.range, st.size);
      if (r === 'bad') { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
      if (r) { res.writeHead(206, { ...hd, 'content-range': 'bytes ' + r.start + '-' + r.end + '/' + st.size, 'content-length': r.end - r.start + 1 }); return pipeFile(res, fs.createReadStream(f, r)); }
      res.writeHead(200, { ...hd, 'content-length': st.size }); return pipeFile(res, fs.createReadStream(f));
    }
    let im;
    if (req.method === 'GET' && (im = p.match(/^\/img\/([\w-]+\.(?:png|jpe?g|webp|gif))$/))) {
      const f = path.join(IMG, im[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const ext = im[1].split('.').pop();
      res.writeHead(200, { 'content-type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext), 'cache-control': 'max-age=31536000' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && (im = p.match(/^\/ico\/([0-9a-f]{16})$/))) { // アイコン画像(中身のハッシュがURLなので、ずっとキャッシュしてよい)
      const e = icons.get(im[1]);
      if (!e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': e.mime, 'cache-control': 'private, max-age=31536000, immutable' });
      return res.end(e.buf);
    }
    if (req.method === 'GET') {
      let f;
      const pm = p.match(/^\/plugins\/([\w.\-]+)\/(.+)$/); // 有効にしたプラグインの js/css だけ配る
      if (pm) f = plugins.isEnabled(pm[1]) && /\.(js|css)$/i.test(pm[2]) ? sec.staticPath(PLUGDIR, '/' + pm[1] + '/' + pm[2]) : null;
      else f = sec.staticPath(PUB, p);
      let st = null; try { st = f && fs.statSync(f); } catch {}
      if (st && st.isFile()) {
        // 画面本体は毎回確認に行くが、変わっていなければ304で終わる。圧縮は最初の1回だけ
        const e = staticFile(f, st), enc = httpLib.pickEncoding(req.headers['accept-encoding']);
        const h = { 'content-type': STATIC_MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', etag: e.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
        if (httpLib.notModified(req.headers['if-none-match'], e.etag)) { res.writeHead(304, { etag: e.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' }); return res.end(); }
        const z = enc === 'br' && e.br ? ['br', e.br] : (enc && e.gz) ? ['gzip', e.gz] : ['', e.raw];
        if (z[0]) h['content-encoding'] = z[0];
        res.writeHead(200, h);
        return res.end(z[1]);
      }
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (e.status === 413) { res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' }); return res.end('{"error":"リクエストが大きすぎます"}'); }
    console.error(e); json(res, { error: e.message }, 500);
  }
});
const staticFile = (f, st) => staticCache(f, st, fs.readFileSync);
// 既存のClaude会話のコンテキスト量を、会話ログの末尾から復元(警告表示用)
function backfillCtx() {
  try {
    const root = path.join(require('os').homedir(), '.claude', 'projects');
    const dirs = fs.readdirSync(root);
    for (const s of sessions) {
      if (s.tool !== 'claude' || !s.nativeId || s.ctx) continue;
      let f = null;
      for (const d of dirs) { const p = path.join(root, d, s.nativeId + '.jsonl'); if (fs.existsSync(p)) { f = p; break; } }
      if (!f) continue;
      const st = fs.statSync(f), n = Math.min(st.size, 300000), fd = fs.openSync(f, 'r'), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
      const lines = b.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        try { const e = JSON.parse(lines[i]); const u = e.message && e.message.usage; if (e.type === 'assistant' && u) { s.ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); s.lastEnd = s.lastEnd || Date.parse(e.timestamp) || 0; break; } } catch {}
      }
    }
    save();
  } catch (e) { console.error('backfill failed', e.message); }
}
const BOOT_ID = Date.now().toString(36) + process.pid;
let listenTries = 0;
server.on('error', e => { // 再起動直後は旧サーバーの終了待ち。子プロセスが多いと遅いので60秒まで粘る
  if (e.code === 'EADDRINUSE' && ++listenTries <= 120) setTimeout(() => server.listen(PORT, '127.0.0.1'), 500);
  else { console.error(e); process.exit(1); }
});
server.once('listening', () => {
  console.log(`ChatDango: http://127.0.0.1:${PORT}`);
  setTimeout(backfillCtx, 2000);
  setTimeout(() => { importCache = importer.list(); importer.warm(importCache).catch(() => {}); }, 1000);
});
server.listen(PORT, '127.0.0.1');
server.keepAliveTimeout = 65000; // 接続を使い回す(既定の5秒だと、少し置くたびに繋ぎ直しで遅くなる)
// 「localhost」はIPv6(::1)を先に試すため、待ち受けがないとWindowsでは毎回200ms前後待たされる。::1でも待ち受ける
const server6 = http.createServer(server.listeners('request')[0]);
server6.keepAliveTimeout = 65000;
let listen6Tries = 0;
server6.on('error', e => { if (e.code === 'EADDRINUSE' && ++listen6Tries <= 120) setTimeout(() => server6.listen(PORT, '::1'), 500); });
server6.listen(PORT, '::1');
// Tailscaleのアドレス(100.x)でも待ち受ける(後からTailscaleを入れても60秒以内に自動で有効化)
const tsServer = http.createServer(server.listeners('request')[0]);
tsServer.keepAliveTimeout = 65000;
let tsIp = null;
tsServer.on('error', e => { console.error('tailscale listen', e.code); tsIp = null; if (e.code === 'EADDRINUSE' && ++tsTries <= 120) setTimeout(startTs, 500); }); // 再起動直後に旧サーバーが握っていても、すぐ取り直す
let tsTries = 0;
function startTs() {
  if (tsIp) return;
  const ip = tailscaleIp(); if (!ip) return;
  tsIp = ip;
  tsServer.listen(PORT, ip, () => console.log('ChatDango (Tailscale): http://' + ip + ':' + PORT));
}
startTs(); setInterval(startTs, 60000);
// OpenCode の無料モデルは入れ替わりが早い。保存してある一覧が古くならないよう、起動の少し後と6時間ごとに、裏で取り直す(失敗しても何もしない)
async function refreshCliModels() {
  for (const c of conns.list()) {
    if (c.kind !== 'cli' || c.provider !== 'opencode' || c.enabled === false) continue;
    try {
      const got = await connLib.fetchModels(c, '', { ...childEnv(), ...(c.env || {}) });
      if (!got.length) continue; // 空の結果で、いまの一覧を消さない
      const keep = (c.models || []).filter(x => x.src !== 'fetched'), ids = new Set(keep.map(x => x.id));
      conns.update(c.id, { models: [...keep, ...got.filter(x => !ids.has(x.id))] });
    } catch {}
  }
}
setTimeout(refreshCliModels, 20000); setInterval(refreshCliModels, 6 * 3600e3).unref();
process.on('exit', () => { if (saveTimer || saving) writeNow(true); for (const c of procs.values()) killTreeSync(c); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
