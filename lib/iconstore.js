'use strict';
// アイコン(dataURL)を一覧JSONに埋め込まず、中身のハッシュを使ったURL(/ico/<hash>)で配る。
// 一覧と状態通知から数百KBが消え、画像はブラウザにキャッシュされる

const crypto = require('crypto');

const DATA_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+\/=]+)$/;
const URL_RE = /^\/ico\/([0-9a-f]{16})$/;
const MAX_ENTRIES = 500;

function createIconStore() {
  const m = new Map(); // hash -> { mime, buf, data }（Map は挿入順なので古いものから捨てる）

  // 画像なら /ico/<hash> に置き換え、絵文字などはそのまま返す
  function urlOf(v) {
    const d = DATA_RE.exec(v || '');
    if (!d) return v || '';
    const h = crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
    if (!m.has(h)) {
      if (m.size >= MAX_ENTRIES) m.delete(m.keys().next().value);
      m.set(h, { mime: d[1], buf: Buffer.from(d[2], 'base64'), data: v });
    }
    return '/ico/' + h;
  }

  // クライアントから戻ってきた値を元のdataURLに戻す。分からないURLは null(=変更しない)
  function resolve(v) {
    const u = URL_RE.exec(v || '');
    if (!u) return v;
    const e = m.get(u[1]);
    return e ? e.data : null;
  }

  const get = hash => m.get(hash) || null;
  return { urlOf, resolve, get };
}

module.exports = { createIconStore, URL_RE };
