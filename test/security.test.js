'use strict';
// 実行: node --test   (パッケージ不要)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sec = require('../lib/security');

const PORT = 5178;

test('isLocalAddr: 自分自身だけ true', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(sec.isLocalAddr(a), a);
  for (const a of ['100.64.0.1', '192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', '', undefined, '127.0.0.2']) assert.ok(!sec.isLocalAddr(a), String(a));
});

test('safeEq: 同じ文字列だけ true / 長さ違い・型違いでも例外なし', () => {
  assert.ok(sec.safeEq('abc', 'abc'));
  assert.ok(!sec.safeEq('abc', 'abd'));
  assert.ok(!sec.safeEq('abc', 'abcd'));
  assert.ok(!sec.safeEq('', 'x'));
  assert.ok(!sec.safeEq(undefined, 'undefined1'));
});

test('cookieOf: 指定の名前だけ取り出す', () => {
  assert.strictEqual(sec.cookieOf('a=1; cc_auth=xyz; b=2', 'cc_auth'), 'xyz');
  assert.strictEqual(sec.cookieOf('xcc_auth=bad', 'cc_auth'), '');
  assert.strictEqual(sec.cookieOf(undefined, 'cc_auth'), '');
});

test('authToken: 合言葉か秘密が変わると変わる', () => {
  const a = sec.authToken({ password: 'p', secret: 's' });
  assert.notStrictEqual(a, sec.authToken({ password: 'q', secret: 's' }));
  assert.notStrictEqual(a, sec.authToken({ password: 'p', secret: 't' }));
  assert.strictEqual(a, sec.authToken({ password: 'p', secret: 's' }));
});

test('hostAllowed: ローカル接続は 127.0.0.1 / localhost だけ(DNSリバインディング・プロキシ対策)', () => {
  assert.ok(sec.hostAllowed('127.0.0.1:5178', true, PORT));
  assert.ok(sec.hostAllowed('localhost:5178', true, PORT));
  for (const h of ['evil.com:5178', 'evil.com', 'localhost:9999', '127.0.0.1', 'my-pc.ts.net:5178', '100.64.1.2:5178', '', undefined]) {
    assert.ok(!sec.hostAllowed(h, true, PORT), 'local: ' + h);
  }
});

test('hostAllowed: 外部接続は Tailscale(100.64-127.x / *.ts.net)だけ', () => {
  assert.ok(sec.hostAllowed('100.100.5.5:5178', false, PORT));
  assert.ok(sec.hostAllowed('my-pc.tail1234.ts.net:5178', false, PORT));
  for (const h of ['evil.com:5178', '192.168.1.5:5178', '100.63.0.1:5178', '100.128.0.1:5178', 'x.ts.net.evil.com:5178', '100.100.5.5:9999', '100.100.5.5']) {
    assert.ok(!sec.hostAllowed(h, false, PORT), 'remote: ' + h);
  }
});

test('originAllowed: 書き込み系は自分のOriginだけ', () => {
  const host = '127.0.0.1:5178';
  assert.ok(sec.originAllowed('GET', 'http://evil.com', host));
  assert.ok(sec.originAllowed('POST', undefined, host));
  assert.ok(sec.originAllowed('POST', 'http://127.0.0.1:5178', host));
  assert.ok(!sec.originAllowed('POST', 'http://evil.com', host));
  assert.ok(!sec.originAllowed('POST', 'http://localhost:5178', host));
  assert.ok(!sec.originAllowed('DELETE', 'null', host));
});

test('tailscaleIp: 100.64.0.0/10 だけ拾う', () => {
  const nets = { a: [{ family: 'IPv4', address: '192.168.1.5' }], b: [{ family: 'IPv6', address: '100.64.0.1' }, { family: 'IPv4', address: '100.101.102.103' }] };
  assert.strictEqual(sec.tailscaleIp(nets), '100.101.102.103');
  assert.strictEqual(sec.tailscaleIp({ a: [{ family: 'IPv4', address: '100.200.0.1' }] }), null);
  assert.strictEqual(sec.tailscaleIp({}), null);
});

test('LoginLimiter: 5回失敗で60秒ロック、成功で解除、時間が過ぎれば解除', () => {
  const l = new sec.LoginLimiter();
  const t = 1000000;
  for (let i = 0; i < 4; i++) { l.fail('ip', t); assert.ok(!l.locked('ip', t)); }
  l.fail('ip', t);
  assert.ok(l.locked('ip', t + 1));
  assert.ok(l.locked('ip', t + 59999));
  assert.ok(!l.locked('ip', t + 60001));
  assert.ok(!l.locked('other', t));
  const l2 = new sec.LoginLimiter();
  for (let i = 0; i < 4; i++) l2.fail('ip', t);
  l2.ok('ip');
  l2.fail('ip', t); assert.ok(!l2.locked('ip', t));
});

test('LoginLimiter: 記録が増えすぎない', () => {
  const l = new sec.LoginLimiter();
  for (let i = 0; i < 2000; i++) l.fail('ip' + i, 1000);
  l.fail('last', 1000 + 10 * 60000);
  assert.ok(l.m.size < 600);
});

test('safeId: resume に渡せるIDは英数字と _ - だけ', () => {
  assert.ok(sec.safeId('3f2a9c1e-1111-4222-8333-444455556666'));
  assert.ok(sec.safeId('rollout_abc-123'));
  for (const v of ['', 'a b', 'a&calc', 'a;b', 'a|b', 'a"b', "a'b", 'a`b', '$(x)', 'a%PATH%', 'a\nb', '../x', 'x'.repeat(101), null, undefined, 123, {}]) {
    assert.ok(!sec.safeId(v), JSON.stringify(v));
  }
});

test('staticPath: 公開フォルダの外は返さない', () => {
  const pub = path.resolve('/tmp/site/public');
  assert.strictEqual(sec.staticPath(pub, '/'), path.join(pub, 'index.html'));
  assert.strictEqual(sec.staticPath(pub, '/a/b.js'), path.join(pub, 'a', 'b.js'));
  for (const p of ['/../server.js', '/..', '/a/../../x', '/%2e%2e/x', '/%2E%2E%2Fx', '/a%5Cb', '/..\\data\\auth.json', '/a\\b', '/a\0b', '//etc/passwd', '/C:/x', '/public-evil/x']) {
    const r = sec.staticPath(pub, p);
    assert.ok(r === null || path.relative(pub, r).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(pub, r)), p + ' -> ' + r);
  }
  assert.strictEqual(sec.staticPath(pub, '/..'), null);
  assert.strictEqual(sec.staticPath(pub, '/../server.js'), null);
  assert.strictEqual(sec.staticPath(pub, '/%2e%2e/x'), null);
  assert.strictEqual(sec.staticPath(pub, '/..\\data\\auth.json'), null);
});
