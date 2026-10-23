'use strict';
// 背景画像/動画(見た目テーマ)の検証。サーバー本体から切り出してテストできるようにしている

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const NAME_RE = /^[\w-]+\.(png|jpe?g|webp|gif|mp4|webm)$/;
const MAX_BYTES = 500 * 1024 * 1024;

const extOf = contentType => TYPES[String(contentType || '').split(';')[0].trim().toLowerCase()] || '';

// 先頭バイトが宣言された形式か(拡張子の偽装で変なファイルを置かせない)
function magicOk(ext, head) {
  if (!head || head.length < 12) return false;
  const a = Buffer.from(head).toString('latin1');
  switch (ext) {
    case 'png': return head[0] === 0x89 && a.slice(1, 4) === 'PNG';
    case 'jpg': case 'jpeg': return head[0] === 0xff && head[1] === 0xd8;
    case 'gif': return a.startsWith('GIF8');
    case 'webp': return a.slice(0, 4) === 'RIFF' && a.slice(8, 12) === 'WEBP';
    case 'mp4': return a.slice(4, 8) === 'ftyp';
    case 'webm': return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default: return false;
  }
}

// Range ヘッダー → { start, end } / null(範囲指定なし) / 'bad'(範囲外)。動画のループ・シークに必要
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = +m[2]; if (n <= 0) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (!(start <= end) || start >= size) return 'bad';
  return { start, end };
}

// フォントファイル(ttf/otf/woff/woff2)。背景とは別の名前空間にして、一覧が混ざらないようにする
const FONT_TYPES = { 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff', 'font/woff2': 'woff2' };
const FONT_MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const FONT_NAME_RE = /^[\w-]+\.(ttf|otf|woff2?)$/;
const FONT_MAX_BYTES = 40 * 1024 * 1024;
const fontExtOf = contentType => FONT_TYPES[String(contentType || '').split(';')[0].trim().toLowerCase()] || '';

function fontMagicOk(ext, head) {
  if (!head || head.length < 4) return false;
  const a = Buffer.from(head).toString('latin1', 0, 4);
  switch (ext) {
    case 'ttf': return a === '\x00\x01\x00\x00' || a === 'true' || a === 'ttcf';
    case 'otf': return a === 'OTTO' || a === '\x00\x01\x00\x00';
    case 'woff': return a === 'wOFF';
    case 'woff2': return a === 'wOF2';
    default: return false;
  }
}

// 元のファイル名から、保存名に使える英数字だけを取り出す(日本語名は落ちるので空なら 'font')
const fontSlug = name => (String(name || '').replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '').slice(0, 24)) || 'font';

module.exports = { TYPES, MIME, NAME_RE, MAX_BYTES, extOf, magicOk, parseRange, FONT_TYPES, FONT_MIME, FONT_NAME_RE, FONT_MAX_BYTES, fontExtOf, fontMagicOk, fontSlug };
