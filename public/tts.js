'use strict';
// 読み上げ用の文章づくり: 返答(Markdown)から「文章の部分だけ」を取り出し、読み上げやすい長さに区切る。
// コード(``` で囲んだ部分・`インラインコード`)、表、URL、画像、貼り付けブロックは読まない。
(function (root) {
  function speechText(src) {
    let t = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    t = t.replace(/〔貼り付け\d+: \d+行〕[\s\S]*?〔貼り付けここまで〕/g, '');
    t = t.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm, '\n'); // コードブロック(閉じていなくても、末尾まで読まない)
    t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][^>\n]*>/g, '');
    t = t.replace(/\{(?:赤|青|緑|黄):([^{}\n]*)\}/g, '$1');     // 色付けの記法は中の語だけ
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                 // 画像
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');              // リンクは文字だけ
    t = t.replace(/`[^`\n]*`/g, '');                            // インラインコード
    t = t.replace(/https?:\/\/[^\s)）」』]+/g, '');             // URL
    const out = [];
    for (let line of t.split('\n')) {
      if (/^\s*\|.*\|\s*$/.test(line)) continue;                // 表
      if (/^\s*[-*_=:| ]{3,}\s*$/.test(line)) continue;         // 区切り線
      line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>+\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
      line = line.replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?![*\w])/g, '$1$2');
      line = line.replace(/[*_#]{2,}/g, '').replace(/\s+/g, ' ').trim();
      if (line) out.push(/[。．.!?！？」』）)]$/.test(line) ? line : line + '。');
    }
    return out.join('\n');
  }

  // 文の終わり(。！？と改行)で区切り、短い文はつなげて、長い文は読点で切る。max は1回に合成する最大文字数
  function split(text, max, first) {
    max = max > 20 ? max : 90;
    const sents = String(text || '').split(/(?<=[。！？!?])|\n+/).map(s => s.trim()).filter(Boolean);
    const out = []; let cur = '';
    const push = s => { while (s.length > max) { let k = s.lastIndexOf('、', max - 1) + 1; if (k < max / 3) k = max; out.push(s.slice(0, k)); s = s.slice(k); } if (s) out.push(s); };
    for (const s of sents) {
      if (cur && (cur + s).length > max) { push(cur); cur = ''; }
      cur += s;
      if (cur.length >= max * 0.6) { push(cur); cur = ''; }
    }
    if (cur) push(cur);
    const res = out.filter(s => /[^\s。、！？!?.,]/.test(s));
    // 最初の1塊だけ短く切る(声が出るまでの待ちを減らす)。短すぎる位置では切らない
    if (first > 8 && res.length && res[0].length > first * 1.3) {
      const h = res[0], k = Math.max(h.lastIndexOf('。', first), h.lastIndexOf('、', first), h.lastIndexOf('！', first), h.lastIndexOf('？', first)) + 1;
      if (k >= first / 2) res.splice(0, 1, h.slice(0, k), h.slice(k));
    }
    return res;
  }

  // 画面の本文(hay)の中で、読み上げる各塊がどこにあたるかを探す。空白・句読点・括弧は無視して比べ、前から順に探す。
  // 戻り値は塊ごとの [開始, 終了) か、見つからなければ null(その塊は光らせない)
  function locate(hay, chunks) {
    const KEEP = ch => !/[\s。、．，.,！？!?「」『』（）()]/.test(ch);
    let nh = '', map = [];
    const H = String(hay || '');
    for (let i = 0; i < H.length; i++) if (KEEP(H[i])) { nh += H[i]; map.push(i); }
    let cur = 0;
    return (chunks || []).map(c => {
      const nc = [...String(c)].filter(KEEP).join('');
      if (!nc) return null;
      const k = nh.indexOf(nc, cur);
      if (k < 0) return null;
      cur = k + nc.length;
      return [map[k], map[cur - 1] + 1];
    });
  }

  const api = { speechText, split, locate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VCTTS = api;
})(typeof window !== 'undefined' ? window : globalThis);
