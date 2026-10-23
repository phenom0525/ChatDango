'use strict';
// 全会話の本文を横断検索する(grep のような単純な文字列一致。AND検索・大文字小文字を区別しない)

const norm = s => String(s || '').toLowerCase();

// 検索語: 空白で区切ると AND("a b" は a も b も含む発言)。全角空白も区切りとして扱う
function terms(q) { return norm(q).split(/[\s　]+/).filter(Boolean).slice(0, 8); }

// 一致箇所の前後を切り出して、1行にした抜粋を返す
function snippet(text, term, ctx) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const i = norm(t).indexOf(term);
  if (i < 0) return t.slice(0, ctx * 2);
  const a = Math.max(0, i - ctx), b = Math.min(t.length, i + term.length + ctx);
  return (a > 0 ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
}

// sessions から検索。新しい発言ほど先。limit件で打ち切る
function search(sessions, q, opt) {
  const o = Object.assign({ limit: 60, ctx: 28, perChat: 8 }, opt), ts = terms(q);
  if (!ts.length) return { hits: [], total: 0, truncated: false };
  const hits = []; let total = 0;
  for (const s of sessions) {
    let n = 0;
    for (const m of s.messages || []) {
      if (!m.id || m.role === 'sys') continue;
      const low = norm(m.text);
      if (!low || !ts.every(t => low.includes(t))) continue;
      total++;
      if (n >= o.perChat) continue; // 1会話から出しすぎない(他の会話も見えるように)
      n++;
      hits.push({ sid: s.id, name: s.name, tool: s.tool, mid: m.id, who: m.role === 'user' ? '自分' : 'AI', snip: snippet(m.text, ts[0], o.ctx), ts: m.ts || 0 });
    }
  }
  hits.sort((a, b) => b.ts - a.ts);
  return { hits: hits.slice(0, o.limit), total, truncated: total > o.limit || hits.length > o.limit };
}

module.exports = { search, terms };
