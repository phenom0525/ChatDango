'use strict';
// 応答の圧縮・キャッシュ判定・本文サイズ上限。サーバー本体から切り出してテストできるようにしている
const zlib = require('zlib');
const crypto = require('crypto');

const MIN_COMPRESS = 1024;

// Accept-Encoding から使える圧縮方式を選ぶ(brotli > gzip)
function pickEncoding(accept) {
  const a = String(accept || '').toLowerCase();
  if (/(^|[\s,])br(\s*[;,]|$)/.test(a)) return 'br';
  if (/(^|[\s,])gzip(\s*[;,]|$)/.test(a)) return 'gzip';
  return '';
}

// 動的な応答用: 速さ優先のgzip。小さいものは圧縮しない
function compressDynamic(buf, accept) {
  const enc = /(^|[\s,])gzip(\s*[;,]|$)/i.test(String(accept || '')) ? 'gzip' : '';
  if (!enc || buf.length < MIN_COMPRESS) return { buf, enc: '' };
  return { buf: zlib.gzipSync(buf, { level: 4 }), enc };
}

// 静的ファイル用: 最初の1回だけ重く圧縮して使い回す(mtimeが変わったら作り直す)
function createStaticCache() {
  const c = new Map(); // path -> { mtimeMs, size, raw, gz, br, etag }
  return function load(file, stat, readFile) {
    let e = c.get(file);
    if (!e || e.mtimeMs !== stat.mtimeMs || e.size !== stat.size) {
      const raw = readFile(file);
      e = {
        mtimeMs: stat.mtimeMs, size: stat.size, raw,
        etag: '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 20) + '"',
        gz: raw.length >= MIN_COMPRESS ? zlib.gzipSync(raw, { level: 9 }) : null,
        br: raw.length >= MIN_COMPRESS ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
      };
      c.set(file, e);
    }
    return e;
  };
}

// If-None-Match に ETag が含まれていれば 304 を返してよい
const notModified = (ifNoneMatch, etag) => !!ifNoneMatch && String(ifNoneMatch).split(',').some(t => t.trim().replace(/^W\//, '') === etag);

// リクエスト本文の上限つき読み込み。超えたら status:413 のエラーで失敗させる
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0, over = false;
    req.on('data', d => {
      if (over) return;
      size += d.length;
      if (size > max) { over = true; parts.length = 0; const e = new Error('リクエストが大きすぎます'); e.status = 413; reject(e); return; }
      parts.push(d);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(parts).toString('utf8')); });
    req.on('error', e => { if (!over) reject(e); });
  });
}

module.exports = { pickEncoding, compressDynamic, createStaticCache, notModified, readBody, MIN_COMPRESS };
