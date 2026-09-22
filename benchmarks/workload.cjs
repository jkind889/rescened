const { uuid, PRESETS } = require('./fixtures.cjs');
const ENDPOINTS = ['search', 'search_page', 'catalog', 'detail', 'social', 'recent', 'popular'];
function cases(preset) {
  const size = PRESETS[preset];
  if (!size) throw new Error('Unknown dataset');
  const queries = ['Blue', 'Sessions', '000019', 'no-such-album-xyz', 'sion', "Guns N' Roses", 'Cafe\u0301', '[Live]', 'Label 3'];
  const search = queries.map((q) => `/search/search?q=${encodeURIComponent(q)}`);
  const albumIds = Array.from({ length: 40 }, (_, i) => uuid('album', (i * 7919) % size.albums));
  return {
    search,
    search_page: search.flatMap((p) => [1, 2, 10].map((page) => `${p}&page=${page}`)),
    catalog: [1, 2, Math.max(1, Math.floor(size.albums / 48))].map((page) => `/albums/catalog?page=${page}`),
    detail: albumIds.map((id) => `/albums/album/${id}`),
    social: albumIds.map((id) => `/albums/album/${id}/social`),
    recent: ['/reviews/recent-albums'], popular: ['/reviews/popular?window=all'],
  };
}
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function validateBody(endpoint, body) {
  const publicId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (/"(?:_id|albumCatalogId)"\s*:/.test(JSON.stringify(body))) throw new Error('Internal ID leaked');
  if (endpoint === 'social') {
    if (!publicId.test(body.albumId) || !Number.isInteger(body.savedCount) || !Array.isArray(body.ratingDistribution)) throw new Error('Invalid social response');
    return;
  }
  const albums = endpoint === 'detail' ? [body] : ['catalog', 'search_page'].includes(endpoint) ? body.results : body;
  if (!Array.isArray(albums) || albums.some((a) => !publicId.test(a.albumId) || !a.title)) throw new Error(`Invalid ${endpoint} response`);
  if (['detail', 'catalog', 'recent', 'popular'].includes(endpoint) && !albums.length) throw new Error('Unexpected empty result');
}
module.exports = { ENDPOINTS, cases, hash, validateBody };
