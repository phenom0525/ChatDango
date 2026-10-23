'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { search, terms } = require('../lib/msgsearch');

const S = [
  { id: 'a', name: 'A', tool: 'claude', messages: [
    { id: 'a1', role: 'user', text: 'ログイン画面で落ちる', ts: 100 },
    { id: 'a2', role: 'assistant', text: '原因は trim() を null に呼んでいたことです', ts: 200 },
    { id: 'a3', role: 'sys', text: 'ログイン 中断', ts: 300 },
    { role: 'user', text: 'ID無しのログイン', ts: 400 },
  ] },
  { id: 'b', name: 'B', tool: 'codex', messages: [{ id: 'b1', role: 'user', text: 'ログインのテスト TRIM', ts: 500 }] },
];

test('terms: 空白(全角含む)で区切り、小文字にする', () => {
  assert.deepEqual(terms('  Foo　bar  '), ['foo', 'bar']);
  assert.deepEqual(terms('   '), []);
});
test('一致する発言だけが、新しい順に返る(sys と id 無しは除く)', () => {
  const r = search(S, 'ログイン');
  assert.deepEqual(r.hits.map(h => h.mid), ['b1', 'a1']);
  assert.equal(r.total, 2);
});
test('大文字小文字を区別せず、AND検索になる', () => {
  assert.deepEqual(search(S, 'trim null').hits.map(h => h.mid), ['a2']);
  assert.deepEqual(search(S, 'trim').hits.map(h => h.mid), ['b1', 'a2']);
  assert.equal(search(S, 'trim zzz').hits.length, 0);
});
test('空の検索語は何も返さない', () => {
  assert.equal(search(S, '  ').hits.length, 0);
});
test('1会話あたりの件数と全体の件数に上限があり、総数は数え続ける', () => {
  const many = [{ id: 'm', name: 'M', tool: 'claude', messages: Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, role: 'user', text: 'hit ' + i, ts: i })) }];
  const r = search(many, 'hit', { perChat: 5, limit: 3 });
  assert.equal(r.hits.length, 3);
  assert.equal(r.total, 30);
  assert.equal(r.truncated, true);
});
test('抜粋は一致箇所の前後を切り出し、改行を空白にする', () => {
  const r = search([{ id: 's', name: 'S', tool: 'claude', messages: [{ id: 's1', role: 'user', text: 'a'.repeat(50) + '\nNEEDLE\n' + 'b'.repeat(50), ts: 1 }] }], 'needle', { ctx: 5 });
  assert.equal(r.hits[0].snip, '…aaaa NEEDLE bbbb…');
});
