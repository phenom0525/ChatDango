'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { speechText, split } = require('../public/tts.js');

test('コードブロックは読まない(閉じていなくても)', () => {
  assert.strictEqual(speechText('直しました。\n```js\nconst a = 1;\n```\n以上です。'), '直しました。\n以上です。');
  assert.strictEqual(speechText('説明です。\n```\nconst a = 1;\nconst b = 2;'), '説明です。');
  assert.ok(!speechText('~~~\nrm -rf /\n~~~\nおわり').includes('rm'));
});

test('インラインコード・URL・画像・表は読まない。リンクは文字だけ', () => {
  const r = speechText('`greet` に引数を足しました。https://example.com/a?b=1 は参考です。[詳細](https://x.y/z)を見てください。\n![図](a.png)\n| 関数 | 役割 |\n|---|---|\n| greet | あいさつ |');
  assert.ok(!/greet|example|http|図|関数|あいさつ/.test(r.replace('詳細', '')), r);
  assert.ok(r.includes('詳細'));
  assert.ok(r.includes('に引数を足しました'));
});

test('見出し・箇条書き・太字などの記号は読まない', () => {
  assert.strictEqual(speechText('## 結果\n- **成功**しました\n1. 次へ進みます\n> 注意です'), '結果。\n成功しました。\n次へ進みます。\n注意です。');
});

test('貼り付けブロックと空入力', () => {
  assert.strictEqual(speechText('本文。\n〔貼り付け1: 3行〕\nsecret\n〔貼り付けここまで〕\n続き。'), '本文。\n続き。');
  assert.strictEqual(speechText(''), '');
  assert.strictEqual(speechText(null), '');
  assert.strictEqual(speechText('```\nコードだけ\n```'), '');
});

test('split: 文で区切り、長すぎる文は読点で切り、短い文はつなぐ', () => {
  assert.deepStrictEqual(split('はい。', 90), ['はい。']);
  const long = ('あ'.repeat(30) + '、').repeat(6) + 'おわり。';
  const parts = split(long, 90);
  assert.ok(parts.length >= 2 && parts.every(p => p.length <= 90));
  assert.strictEqual(parts.join(''), long);
  assert.ok(split('一。二。三。', 90).length === 1);
  assert.deepStrictEqual(split('', 90), []);
  assert.deepStrictEqual(split('。。。', 90), []);
});

test('色付けの記法は中の語だけ読む', () => {
  assert.strictEqual(speechText('原因は{赤:空文字}と{青:null}です。'), '原因は空文字とnullです。');
});

test('locate: 画面の本文から読み上げの塊の位置を前から順に探す(コード・句読点・空白は無視)', () => {
  const { locate } = require('../public/tts.js');
  const hay = '見出し\n計算は  です。次に、動かします!\nおわり';
  const r = locate(hay, ['見出し。', '計算は です。', '次に、動かします!', 'おわり。']);
  assert.deepStrictEqual(r.map(x => hay.slice(x[0], x[1])), ['見出し', '計算は  です', '次に、動かします', 'おわり']);
  assert.deepStrictEqual(locate('abc', ['zzz', 'a']), [null, [0, 1]]);
  assert.deepStrictEqual(locate('あいう', ['。', '']), [null, null]);
});

test('split: first を指定すると最初の1塊だけ短く切る(切れる位置が無ければそのまま)', () => {
  const s = 'これは最初の文です。' + 'あ'.repeat(40) + 'という二つ目の長めの文です。' + 'おわりの文です。';
  const a = split(s, 90), b = split(s, 90, 20);
  assert.strictEqual(a.join(''), b.join(''));
  assert.ok(b[0].length <= 20 && b.length === a.length + 1);
  assert.deepStrictEqual(split('あ'.repeat(60), 90, 20), ['あ'.repeat(60)]);
});
