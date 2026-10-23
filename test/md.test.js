'use strict';
// チャットのMarkdown描画(public/index.html の md)。コード内の引用符がリンクの属性に混ざらないことを確認する
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const h = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const a = h.indexOf('const esc = s'), b = h.indexOf('const hm = ts');
const ctx = { window: {}, RE_CTL: /\u0000/g, ansi: x => x, COLORS: {} };
vm.createContext(ctx);
vm.runInContext(h.slice(a, b) + ';this.md = md;', ctx);
const md = ctx.md;

test('リンクのURLにコードを入れても属性は増えない', () => {
  for (const t of ['[d](https://e.invalid/`" onmouseover="alert(1)//`)', '![x](https://a.b/`" onerror="1`)']) {
    const out = md(t);
    assert.ok(!/<a [^>]*onmouseover|<img [^>]*onerror|<a [^>]*onerror/.test(out), out);
    assert.ok(!/" on\w+=/.test(out), out);
  }
});
test('通常のリンク・コード・強調は描画される', () => {
  const out = md('`a"b` と [ok](https://x.y/z) **太字**');
  assert.match(out, /<code>a&quot;b<\/code>/);
  assert.match(out, /<a href="https:\/\/x\.y\/z"/);
  assert.match(out, /<strong>太字<\/strong>/);
});
test('生のHTMLはエスケープされる', () => {
  assert.ok(!md('<img src=x onerror=alert(1)>').includes('<img'));
});
