// AI接続管理のテスト: OpenAI互換APIはモック鯖、CLIは偽CLI(node)で通信なし・課金なしに検証する
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/connections');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- モック OpenAI互換サーバー ----
let seen = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || '', body: b ? JSON.parse(b) : null });
    const a = req.headers.authorization || '';
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b-free' }, { id: 'bad id' }] })); }
    if (a === 'Bearer BADKEY') { res.writeHead(401); return res.end('{"error":{"message":"Incorrect API key BADKEY"}}'); }
    if (a === 'Bearer NOMONEY') { res.writeHead(402); return res.end('{"error":{"message":"Insufficient Balance"}}'); }
    if (a === 'Bearer LIMIT') { res.writeHead(429); return res.end('{"error":{"message":"rate limit"}}'); }
    if (b.includes('"gone"')) { res.writeHead(404); return res.end('{"error":{"message":"The model gone does not exist"}}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ch = t => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n';
    if (b.includes('"slow"')) { res.write(ch('はじめ')); const iv = setInterval(() => res.write(ch('.')), 30); req.on('close', () => clearInterval(iv)); return; }
    res.write(ch('こん')); res.write(ch('にちは')); res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }) + '\n\n'); res.end('data: [DONE]\n\n');
  });
});
let base;
test.before(() => new Promise(r => mock.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + mock.address().port + '/v1'; r(); })));
test.after(() => mock.close());

const mkH = () => { const o = { texts: [], deltas: [], tools: [], errors: [], usage: null, sessions: [] }; return { o, h: { onText: t => o.texts.push(t), onDelta: d => o.deltas.push(d), onTool: t => o.tools.push(t), onError: e => o.errors.push(e), onUsage: u => o.usage = u, onSession: id => o.sessions.push(id) } }; };
const apiConn = { kind: 'api', provider: 'openai', baseUrl: '', caps: { chat: true } };
const A = (key, model = 'm', text = 'hi') => ({ text, model, key, history: [{ role: 'user', content: text }], system: 'sys' });

test('API: ストリーミングで部分表示と最終テキストと使用量が揃う', async () => {
  const { o, h } = mkH(); seen = [];
  await C.run({ ...apiConn, baseUrl: base }, A('GOODKEY'), h).done;
  assert.deepStrictEqual(o.deltas, ['こん', 'にちは']);
  assert.deepStrictEqual(o.texts, ['こんにちは']);
  assert.deepStrictEqual(o.usage, { in: 7, out: 3 });
  assert.strictEqual(o.errors.length, 0);
  assert.strictEqual(seen[0].auth, 'Bearer GOODKEY');
  assert.strictEqual(seen[0].body.stream, true);
  assert.strictEqual(seen[0].body.messages[0].role, 'system');
});
test('API: キーなし接続はAuthorizationを付けない', async () => {
  const { o, h } = mkH(); seen = [];
  await C.run({ ...apiConn, baseUrl: base }, A(''), h).done;
  assert.strictEqual(seen[0].auth, ''); assert.deepStrictEqual(o.texts, ['こんにちは']);
});
test('API: 失敗は原因別に分類され、キーが本文に出ない', async () => {
  const cases = [['BADKEY', 'bad_key'], ['NOMONEY', 'balance'], ['LIMIT', 'rate']];
  for (const [key, code] of cases) {
    const { o, h } = mkH(); await C.run({ ...apiConn, baseUrl: base }, A(key), h).done;
    assert.strictEqual(o.errors.length, 1); assert.strictEqual(o.errors[0].code, code, key);
    assert.ok(!JSON.stringify(o.errors[0]).includes(key), 'キーが漏れている');
    assert.ok(o.errors[0].hint.length > 0);
  }
  const { o, h } = mkH(); await C.run({ ...apiConn, baseUrl: base }, A('K', 'gone'), h).done;
  assert.strictEqual(o.errors[0].code, 'model');
});
test('API: 接続できないときは network、モデル未指定は model', async () => {
  let r = mkH(); await C.run({ ...apiConn, baseUrl: 'http://127.0.0.1:1/v1' }, A('K'), r.h).done;
  assert.strictEqual(r.o.errors[0].code, 'network');
  r = mkH(); await C.run({ ...apiConn, baseUrl: base }, A('K', ''), r.h).done;
  assert.strictEqual(r.o.errors[0].code, 'model');
});
test('API: 停止すると通信を打ち切り、エラー扱いにしない', async () => {
  const { o, h } = mkH(); const r = C.run({ ...apiConn, baseUrl: base }, A('K', 'slow'), h);
  await new Promise(s => setTimeout(s, 150)); r.handle.abort(); await r.done;
  assert.strictEqual(o.errors.length, 0); assert.ok(o.deltas.length >= 1);
});
test('API: モデル一覧取得は不正IDを捨て、-freeを推定する', async () => {
  const m = await C.fetchModels({ kind: 'api', baseUrl: base }, 'K', {});
  assert.deepStrictEqual(m.map(x => x.id), ['m-a', 'm-b-free']);
  assert.strictEqual(m[1].cost, 'free'); assert.strictEqual(m[0].cost, 'unknown');
});
test('API: 接続テスト(成功/鍵エラー)', async () => {
  assert.strictEqual((await C.test({ kind: 'api', baseUrl: base }, 'K', {})).status, 'available');
  assert.strictEqual((await C.test({ kind: 'api', baseUrl: 'http://127.0.0.1:1/v1' }, 'K', {})).status, 'failed');
});

// ---- 偽CLI ----
const fake = (name, lines, code = 0, errText = '') => {
  const f = path.join(tmp, name + '.js');
  fs.writeFileSync(f, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write(${JSON.stringify(errText)});require('fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.stdin'))},s);require('fs').writeFileSync(${JSON.stringify(path.join(tmp, name + '.argv'))},JSON.stringify(process.argv.slice(2)));for(const l of ${JSON.stringify(lines)})console.log(typeof l==='string'?l:JSON.stringify(l));process.exit(${code})})`);
  return f;
};
const cliConn = (provider, script, resume) => ({ kind: 'cli', provider, exe: process.execPath, preArgs: [script], caps: { chat: true, resume } });
const runCli = (conn, a) => { const r = mkH(); return C.run(conn, { cwd: tmp, env: process.env, history: [], ...a }, r.h).done.then(() => r.o); };

test('OpenCode: JSONイベントを共通イベントに変換し、引数とstdinが正しい', async () => {
  const f = fake('oc', [{ type: 'step_start', sessionID: 'ses_abc', part: {} }, { type: 'tool_use', sessionID: 'ses_abc', part: { tool: 'bash', state: { input: { command: 'ls -la' } } } }, { type: 'text', sessionID: 'ses_abc', part: { text: '終わりました' } }, { type: 'step_finish', part: { tokens: { input: 11, output: 4 } } }]);
  const o = await runCli(cliConn('opencode', f, true), { text: '質問です', model: 'opencode/foo-free', nativeId: 'ses_prev' });
  assert.deepStrictEqual(o.texts, ['終わりました']); assert.deepStrictEqual(o.tools, ['bash  ls -la']);
  assert.strictEqual(o.sessions[0], 'ses_abc'); assert.deepStrictEqual(o.usage, { in: 11, out: 4 }); assert.strictEqual(o.errors.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'oc.stdin'), 'utf8'), '質問です');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'oc.argv'), 'utf8')), ['run', '--format', 'json', '-m', 'opencode/foo-free', '--session', 'ses_prev']);
});
test('Gemini CLI: 部分メッセージをまとめ、ツール・結果を変換。全許可でだけ --yolo', async () => {
  const lines = [{ type: 'init', session_id: 'g1', model: 'x' }, { type: 'message', role: 'user', content: 'q' }, { type: 'message', role: 'assistant', content: 'こん', delta: true }, { type: 'message', role: 'assistant', content: 'にちは', delta: true }, { type: 'tool_use', tool_name: 'read_file', parameters: { path: 'a.txt' } }, { type: 'message', role: 'assistant', content: '読みました', delta: true }, { type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } }];
  const f = fake('gm', lines);
  let o = await runCli(cliConn('gemini', f, false), { text: '質問', model: '', perm: 'safe', history: [{ role: 'user', content: '前の質問' }, { role: 'assistant', content: '前の答え' }] });
  assert.deepStrictEqual(o.texts, ['こんにちは', '読みました']); assert.deepStrictEqual(o.tools, ['read_file  a.txt']); assert.deepStrictEqual(o.usage, { in: 5, out: 2 });
  assert.ok(!JSON.parse(fs.readFileSync(path.join(tmp, 'gm.argv'), 'utf8')).includes('--yolo'), '安全寄りで --yolo が付いた');
  const stdin = fs.readFileSync(path.join(tmp, 'gm.stdin'), 'utf8'); assert.ok(stdin.includes('前の答え') && stdin.endsWith('質問'), '再開できないCLIには会話を文章で渡す');
  o = await runCli(cliConn('gemini', f, false), { text: '質問', perm: 'full' });
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'gm.argv'), 'utf8')).includes('--yolo'));
});
test('CLI: 異常終了・ログイン要求・未インストールを分類する', async () => {
  let o = await runCli(cliConn('opencode', fake('e1', [], 1, 'Error: not logged in. Please log in'), true), { text: 'x' });
  assert.strictEqual(o.errors.length, 1); assert.strictEqual(o.errors[0].code, 'login');
  o = await runCli(cliConn('opencode', fake('e2', [{ type: 'error', error: { data: { message: 'rate limit exceeded for free usage' } } }], 1), true), { text: 'x' });
  assert.strictEqual(o.errors.length, 1); assert.strictEqual(o.errors[0].code, 'rate');
  o = await runCli({ kind: 'cli', provider: 'opencode', exe: 'definitely-not-installed-cli', preArgs: [], caps: { resume: true } }, { text: 'x' });
  assert.strictEqual(o.errors[0].code, 'cli_missing');
  o = await runCli(cliConn('opencode', fake('e3', [], 0), true), { text: 'x' });
  assert.strictEqual(o.errors[0].msg, '返答がありませんでした');
});
test('CLI: 停止するとプロセスを終了し、エラー扱いにしない', async () => {
  const f = path.join(tmp, 'hang.js'); fs.writeFileSync(f, 'process.stdin.resume();setInterval(()=>{},1000)');
  const r = mkH(); const run = C.run(cliConn('opencode', f, true), { text: 'x', cwd: tmp, env: process.env, history: [] }, r.h);
  await new Promise(s => setTimeout(s, 300)); assert.ok(run.handle.pid > 0);
  run.handle.stopped = true; run.handle.child.kill(); await run.done; assert.strictEqual(r.o.errors.length, 0);
});
test('CLI: 引数・パスにシェル文字を通さない', () => {
  assert.throws(() => C.spawnCli(process.execPath, ['a&calc'], {}), /使えない文字/);
  assert.throws(() => C.spawnCli(process.execPath, ['a b'], {}), /使えない文字/);
  assert.throws(() => C.spawnCli('C:\\x&y\\a.cmd', ['a'], {}), /使えない文字/);
  assert.ok(C.OK_MODEL.test('opencode/deepseek-v4-flash-free') && !C.OK_MODEL.test('a b') && !C.OK_MODEL.test('a;b'));
});

// ---- 登録・キー ----
test('登録: 入力検証・キーは画面用の形に含まれない・暗号化保存と復号', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 's-')); const st = C.createStore(dir);
  assert.throws(() => st.create({ provider: 'x', kind: 'cli', exe: 'a&b' }), /使えない文字/);
  assert.throws(() => st.create({ provider: 'openai', kind: 'api', baseUrl: 'javascript:alert(1)' }), /URL/);
  assert.throws(() => st.create({ provider: 'x', kind: 'cli', exe: 'a', preArgs: ['--x', 'a;b'] }), /起動引数/);
  assert.throws(() => st.create({ provider: 'x', kind: 'cli', exe: 'a', env: { PATH: 'x' } }), /環境変数/);
  const c = st.create({ provider: 'deepseek' });
  assert.strictEqual(c.baseUrl, 'https://api.deepseek.com'); assert.ok(c.models.every(m => m.cost === 'paid' && m.src === 'preset')); assert.ok(c.costInfo.checkedAt);
  assert.strictEqual(c.caps.exec, false, 'APIにコマンド実行の能力を出してはいけない');
  st.setKey(c.id, 'sk-SECRET-VALUE-12345');
  assert.strictEqual(st.hasKey(c), true); assert.strictEqual(st.getKey(c), 'sk-SECRET-VALUE-12345');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('SECRET-VALUE'), f + ' に平文のキー');
  assert.ok(!JSON.stringify(st.view(c, true)).includes('SECRET-VALUE'));
  const st2 = C.createStore(dir); assert.strictEqual(st2.getKey(st2.get(c.id)), 'sk-SECRET-VALUE-12345'); // 再起動後も復号できる
  st2.remove(c.id); assert.strictEqual(st2.hasKey(c), false);
  assert.ok(!('secrets' in JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'))) && !fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes(c.id));
});
test('分類: 代表的な失敗メッセージ', () => {
  const k = (t, s, kind) => C.classify(t, s, kind).code;
  assert.strictEqual(k('', 401, 'api'), 'bad_key'); assert.strictEqual(k('', 401, 'cli'), 'login'); assert.strictEqual(k('', 402, 'api'), 'balance');
  assert.strictEqual(k('', 429, 'api'), 'rate'); assert.strictEqual(k('', 404, 'api'), 'model'); assert.strictEqual(k('getaddrinfo ENOTFOUND x', 0, 'api'), 'network');
  assert.strictEqual(k("'foo' is not recognized as an internal or external command", 0, 'cli'), 'cli_missing');
  assert.strictEqual(k('Free usage limit reached', 0, 'cli'), 'rate');
  assert.strictEqual(k('Unexpected server error. Check server logs for details.', 0, 'cli'), 'model'); // OpenCode: 終了したモデルを指定したときの表示
});
test('redact: キーらしき文字列を伏せる', () => {
  assert.ok(!C.redact('failed with key sk-abcdefghijklmnopqrstuvwxyz0123', '').includes('abcdefghij'));
  assert.ok(!C.redact('xx MYSECRETKEY yy', 'MYSECRETKEY').includes('MYSECRETKEY'));
});
