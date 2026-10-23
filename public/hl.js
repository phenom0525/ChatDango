'use strict';
// コードブロックの簡易シンタックスハイライト(外部ライブラリなし)。
// highlight(code, lang) は HTML 文字列を返す。中身は必ずエスケープ済みで、使うタグは <span class="tk-…"> だけ。
// 言語が分からない/長すぎるときは色を付けずにエスケープだけして返す。
(function (root) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MAX = 60000;
  const set = s => new Set(s.split(/\s+/).filter(Boolean));

  const C_KW = 'if else for while do switch case break continue return default goto try catch finally throw throws new delete typeof instanceof in of void yield await async static const let var function class extends implements interface enum struct union namespace package import export from as public private protected final abstract override virtual this super self with where fn mut pub use mod impl trait match loop move ref dyn crate unsafe extern typedef sizeof template typename using operator inline volatile register signed unsigned readonly type declare module keyof satisfies get set fun val object when is lateinit data sealed';
  const C_LIT = 'true false null undefined NaN Infinity nil None True False NULL nullptr';
  const C_TYPE = 'int long short char float double bool boolean byte string String number any unknown never object void i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 str Vec Option Result Self';
  const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls print';
  const SH_KW = 'if then else elif fi for while until do done case esac in function select return exit break continue local export readonly declare set unset source alias echo cd ls cat grep sed awk git npm npx node python pip sudo rm cp mv mkdir curl wget Write-Host Get-ChildItem Set-Location Remove-Item param foreach switch begin process end';
  const SQL_KW = 'select from where group by order having join inner outer left right full cross on as and or not in is null like between exists union all insert into values update set delete create alter drop table index view database primary key foreign references default unique distinct limit offset case when then else end count sum avg min max with returning';
  const CSS_KW = 'important';
  const YAML_LIT = 'true false null yes no on off';

  // 言語ごとの設定。lc=行コメント、bc=ブロックコメント、q=文字列の引用符、tq=三連引用符
  const BASE = { lc: ['//'], bc: ['/*', '*/'], q: '"\'', tq: false, kw: set(C_KW), lit: set(C_LIT), ty: set(C_TYPE), ci: false, fn: true };
  const LANGS = {
    js: { ...BASE, q: '"\'`' },
    c: { ...BASE },
    py: { ...BASE, lc: ['#'], bc: null, tq: true, kw: set(PY_KW), ty: set('int str float bool list dict set tuple bytes object type') },
    sh: { ...BASE, lc: ['#'], bc: null, kw: set(SH_KW), lit: set('true false'), ty: set(''), fn: false },
    ps: { ...BASE, lc: ['#'], bc: ['<#', '#>'], kw: set(SH_KW), lit: set('$true $false $null'), ty: set(''), ci: true, fn: false },
    bat: { ...BASE, lc: ['REM ', '::'], bc: null, kw: set('echo set if else for do goto call exit rem pause cd copy del move start setlocal endlocal not exist errorlevel'), lit: set(''), ty: set(''), ci: true, fn: false },
    sql: { ...BASE, lc: ['--'], kw: set(SQL_KW), lit: set('true false null'), ty: set(''), ci: true, fn: true },
    css: { ...BASE, lc: null, kw: set(CSS_KW), lit: set(''), ty: set(''), fn: true },
    yaml: { ...BASE, lc: ['#'], bc: null, kw: set(''), lit: set(YAML_LIT), ty: set(''), fn: false },
    toml: { ...BASE, lc: ['#'], bc: null, kw: set(''), lit: set('true false'), ty: set(''), fn: false },
    json: { ...BASE, lc: null, bc: null, q: '"', kw: set(''), lit: set('true false null'), ty: set(''), fn: false },
    lua: { ...BASE, lc: ['--'], bc: ['--[[', ']]'], kw: set('and break do else elseif end for function goto if in local not or repeat return then until while'), lit: set('true false nil'), ty: set(''), fn: true },
    rb: { ...BASE, lc: ['#'], bc: null, kw: set('def end class module if elsif else unless case when while until for in do begin rescue ensure return yield require require_relative include extend attr_accessor puts self and or not then lambda proc'), lit: set('true false nil'), ty: set(''), fn: true },
    php: { ...BASE, lc: ['//', '#'], kw: set(C_KW + ' echo function foreach endforeach endif elseif array isset empty require include namespace use'), fn: true },
  };
  const ALIAS = {
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
    c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', java: 'c', kotlin: 'c', kt: 'c', swift: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', scala: 'c', dart: 'c',
    py: 'py', python: 'py', python3: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', ps1: 'ps', powershell: 'ps', pwsh: 'ps', bat: 'bat', cmd: 'bat', batch: 'bat',
    sql: 'sql', css: 'css', scss: 'css', less: 'css', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'toml', json: 'json', jsonc: 'json', json5: 'json',
    lua: 'lua', rb: 'rb', ruby: 'rb', php: 'php',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', diff: 'diff', patch: 'diff',
  };
  const span = (c, t) => '<span class="tk-' + c + '">' + esc(t) + '</span>';

  function scan(code, L) {
    let out = '', i = 0, plain = '';
    const n = code.length;
    const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
    const emit = (c, t) => { flush(); out += span(c, t); };
    const starts = (p, at) => code.startsWith(p, at);
    while (i < n) {
      const ch = code[i];
      // ブロックコメント
      if (L.bc && starts(L.bc[0], i)) { let j = code.indexOf(L.bc[1], i + L.bc[0].length); j = j < 0 ? n : j + L.bc[1].length; emit('c', code.slice(i, j)); i = j; continue; }
      // 行コメント(行頭または空白の後ろだけ。URLの // や 文字列内の # を誤認しない)
      const lc = L.lc && L.lc.find(p => starts(p, i) && (p !== '#' || i === 0 || /[\s;({,]/.test(code[i - 1])));
      if (lc) { let j = code.indexOf('\n', i); if (j < 0) j = n; emit('c', code.slice(i, j)); i = j; continue; }
      // 文字列
      if (L.q.includes(ch)) {
        if (L.tq && starts(ch + ch + ch, i)) { let j = code.indexOf(ch + ch + ch, i + 3); j = j < 0 ? n : j + 3; emit('s', code.slice(i, j)); i = j; continue; }
        let j = i + 1;
        while (j < n && code[j] !== ch && (ch === '`' || code[j] !== '\n')) { if (code[j] === '\\') j++; j++; }
        j = Math.min(n, j + 1);
        const str = code.slice(i, j);
        // JSONのキー(直後が :)は別色
        if (L === LANGS.json && /^\s*:/.test(code.slice(j, j + 8))) emit('a', str); else emit('s', str);
        i = j; continue;
      }
      // 数値
      if (/[0-9]/.test(ch) && (i === 0 || !/[\w$]/.test(code[i - 1]))) {
        const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/.exec(code.slice(i, i + 40));
        if (m) { emit('n', m[0]); i += m[0].length; continue; }
      }
      // 識別子
      if (/[A-Za-z_$@]/.test(ch)) {
        const w = (/^[@$]?[A-Za-z_][\w$]*/.exec(code.slice(i, i + 80)) || [ch])[0];
        const key = L.ci ? w.toLowerCase() : w;
        const nxt = code[i + w.length];
        if (L.lit.has(key)) emit('l', w);
        else if (L.kw.has(key)) emit('k', w);
        else if (L.ty.has(key)) emit('t', w);
        else if (L.fn && nxt === '(') emit('f', w);
        else if (/^[A-Z][A-Za-z0-9]*[a-z]/.test(w) && L !== LANGS.sh) emit('t', w);
        else plain += w;
        i += w.length; continue;
      }
      plain += ch; i++;
    }
    flush();
    return out;
  }

  function html(code) {
    let out = '', i = 0;
    const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z!][^>]*>?/g;
    let m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(i, m.index)); i = m.index + m[0].length;
      const t = m[0];
      if (t.startsWith('<!--')) { out += span('c', t); continue; }
      const head = /^<\/?[^\s>\/]+/.exec(t)[0];
      let rest = t.slice(head.length), r = '';
      const ar = /\s+|[^\s=>\/"']+|=|"[^"]*"?|'[^']*'?|\/?>|\//g; let a, prevEq = false;
      while ((a = ar.exec(rest))) {
        const x = a[0];
        if (/^\s+$/.test(x)) r += x;
        else if (x === '=') { r += esc(x); prevEq = true; continue; }
        else if (/^["']/.test(x)) r += span('s', x);
        else if (/^\/?>$/.test(x) || x === '/') r += span('k', x);
        else r += prevEq ? span('s', x) : span('a', x);
        prevEq = false;
      }
      out += span('k', head) + r;
    }
    return out + esc(code.slice(i));
  }

  function diff(code) {
    return code.split('\n').map(l => {
      const c = l.startsWith('@@') ? 'dm' : /^(\+\+\+|---|diff |index )/.test(l) ? 'c' : l[0] === '+' ? 'da' : l[0] === '-' ? 'dd' : '';
      return c ? span(c, l) : esc(l);
    }).join('\n');
  }

  function highlight(code, lang) {
    code = String(code);
    const key = ALIAS[String(lang || '').toLowerCase().replace(/^language-/, '')];
    if (!key || code.length > MAX) return esc(code);
    try {
      if (key === 'html') return html(code);
      if (key === 'diff') return diff(code);
      return scan(code, LANGS[key]);
    } catch { return esc(code); }
  }

  const api = { highlight, known: l => !!ALIAS[String(l || '').toLowerCase()] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VCHL = api;
})(typeof window !== 'undefined' ? window : globalThis);
