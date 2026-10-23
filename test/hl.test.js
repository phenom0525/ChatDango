'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { highlight, known } = require('../public/hl.js');

// 色付けしても文字は1つも増減しない(タグを外して実体参照を戻すと元のコードに一致する)
const strip = h => h.replace(/<\/?span[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('文字が欠けたり増えたりしない(各言語)', () => {
  const samples = {
    js: 'const a = `x${1}`; // メモ\nfunction f(x) { return x < 2 && "a\\"b"; }\n/* ブロック\n複数行 */',
    py: 'def f(x):\n    """doc\nstring"""\n    return x # c\nprint("a", 0x1F, 1.5e3)',
    sh: 'echo "hi" # c\nif [ -f a ]; then ls -la; fi\nURL=http://a.b/#x',
    json: '{"a": [1, true, null], "b": {"c": "d"}}',
    sql: "SELECT a, COUNT(*) FROM t WHERE x = 'y' -- c\nORDER BY 1;",
    css: 'a:hover { color: #fff; margin: 0 auto !important; } /* c */',
    html: '<!-- c --><div class="a" id=b data-x=\'1\'>text &amp; <b>x</b></div><br/>',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx',
    yaml: 'a: 1\nb: [x, y] # c\nc: "s"',
    ps: '$x = Get-ChildItem -Path "C:\\a" # c\nif ($true) { Write-Host $x }',
  };
  for (const [lang, code] of Object.entries(samples)) assert.strictEqual(strip(highlight(code, lang)), code, lang);
});

test('壊れた入力・途中までの入力でも落ちず、文字も欠けない', () => {
  const bad = ['"未閉じの文字列', '/* 未閉じ', '<div class="x', '<!-- 未閉じ', '`未閉じ ${', '"""三連', '\\', '', '$', '@', '0x', '1e'];
  for (const lang of ['js', 'py', 'html', 'sh', 'json', 'c', 'sql', 'diff']) for (const code of bad) assert.strictEqual(strip(highlight(code, lang)), code, lang + ': ' + code);
});

test('ランダムな文字列でも文字が変わらず、終わる(ファジング)', () => {
  const pool = ['"', "'", '`', '/', '*', '#', '<', '>', '&', '\n', ' ', 'a', 'if', '(', ')', '1', '.', '-', '=', '\\', '{', '}', '$', '@', '日本', '!', '--', '//', '/*', '*/', '<!--', '-->'];
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 300; t++) {
    let code = ''; for (let k = rnd(60); k > 0; k--) code += pool[rnd(pool.length)];
    for (const lang of ['js', 'py', 'html', 'sh', 'json', 'diff', 'css', 'sql']) assert.strictEqual(strip(highlight(code, lang)), code, lang + ': ' + JSON.stringify(code));
  }
});

test('危険な文字は必ずエスケープされ、タグは span だけ', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';
  for (const lang of ['js', 'html', 'py', 'sh', 'json', 'diff', 'unknown', '']) {
    const h = highlight(evil, lang);
    assert.ok(!/<(?!\/?span[ >])/.test(h), lang + ': ' + h);
    assert.ok(!/<script|<img/i.test(h), lang);
  }
  const h2 = highlight('"<img src=x onerror=1>"', 'js');
  assert.ok(h2.includes('&lt;img'));
});

test('言語の判定と色付けの中身', () => {
  assert.ok(known('JavaScript') && known('ts') && known('PowerShell') && !known('klingon'));
  assert.strictEqual(highlight('a < b', 'klingon'), 'a &lt; b'); // 未知の言語は色なし
  assert.strictEqual(highlight('a < b', ''), 'a &lt; b');
  const js = highlight('const x = foo(1, "s"); // c', 'js');
  assert.ok(js.includes('<span class="tk-k">const</span>'));
  assert.ok(js.includes('<span class="tk-f">foo</span>'));
  assert.ok(js.includes('<span class="tk-n">1</span>'));
  assert.ok(js.includes('<span class="tk-s">&quot;s&quot;</span>'));
  assert.ok(js.includes('<span class="tk-c">// c</span>'));
  assert.ok(highlight('{"k": 1}', 'json').includes('<span class="tk-a">&quot;k&quot;</span>'));
  assert.ok(highlight('+add\n-del', 'diff').includes('tk-da') && highlight('+add\n-del', 'diff').includes('tk-dd'));
});

test('文字列やURLの中の // # は、コメント扱いにならない', () => {
  assert.ok(!highlight('const u = "http://a.b/c";', 'js').includes('tk-c'));
  assert.ok(!highlight('echo a#b', 'sh').includes('tk-c'));
  assert.ok(highlight('echo a # b', 'sh').includes('tk-c'));
});

test('大きすぎるコードは色付けしない(重さ対策)', () => {
  const big = 'a = 1\n'.repeat(20000);
  assert.ok(!highlight(big, 'py').includes('<span'));
});

test('実行時間: 5万文字でも十分速い', () => {
  const code = 'function f(x) { return "s" + x; } // c\n'.repeat(1300);
  const t = Date.now(); highlight(code, 'js'); assert.ok(Date.now() - t < 500, (Date.now() - t) + 'ms');
});
