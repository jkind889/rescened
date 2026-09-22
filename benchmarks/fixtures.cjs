const crypto = require('node:crypto');
const mongoose = require('mongoose');

const PRESETS = {
  smoke: { albums: 100, reviews: 1000, memberships: 500 },
  small: { albums: 10000, reviews: 100000, memberships: 50000 },
  main: { albums: 50000, reviews: 500000, memberships: 250000 },
};
const EPOCH = new Date('2026-09-01T00:00:00Z');
const SEED = 'rescened-benchmark-v1';
function hex(domain, i) { return crypto.createHash('sha256').update(`${SEED}:${domain}:${i}`).digest('hex'); }
function uuid(domain, i) {
  const h = hex(domain, i);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function oid(domain, i) { return new mongoose.Types.ObjectId(hex(domain, i).slice(0, 24)); }
function album(i) {
  const words = ['Midnight', 'Blue', 'Quiet', 'Golden', 'Electric', 'Northern', 'Soft', 'Silver'];
  const artist = i % 17 === 0 ? 'Guns N’ Roses Ensemble' : `Artist ${String(i % 997).padStart(4, '0')}`;
  return {
    _id: oid('album', i), albumId: uuid('album', i),
    title: `${words[i % words.length]} ${i % 19 === 0 ? 'Café [Live]' : 'Sessions'} ${String(i).padStart(6, '0')}`,
    artistDisplayName: artist, artistCredits: [{ name: artist, role: 'main' }],
    releaseType: 'album', releaseDate: '2020', releaseDatePrecision: 'year', releaseYear: 2020,
    label: `Label ${i % 23}`, cover: '', catalogSource: 'manual', catalogRevision: 1,
    fieldProvenance: {}, createdAt: EPOCH, updatedAt: EPOCH,
    // Exact synthetic identities keep the unique multikey provenance index populated.
    externalReferences: [{ provider: 'benchmark', entityType: 'album', externalId: String(i), url: '' }],
    tracks: Array.from({ length: 6 + i % 9 }, (_, j) => ({
      trackId: uuid('track', i * 20 + j), discNumber: 1, trackNumber: j + 1,
      title: `Movement ${j + 1}`, durationMs: 120000 + (i * 7919 + j * 1000) % 240000,
      artistDisplayName: artist,
    })),
  };
}
// Exactly 80% of each ten-row cycle targets the first 20% of albums.
function activityAlbum(i, count) {
  const hot = count / 5;
  const cycle = Math.floor(i / 10);
  return i % 10 < 8 ? (cycle * 8 + i % 10) % hot : hot + (cycle * 2 + i % 10 - 8) % (count - hot);
}
function models() {
  return {
    albums: require('../models/AlbumCatalog'), boards: require('../models/Board'),
    reviews: require('../models/Reviews'), memberships: require('../models/BoardItem'),
  };
}
function* rows(kind, preset) {
  const size = PRESETS[preset];
  if (!size) throw new Error(`Unknown dataset: ${preset}`);
  if (kind === 'albums') { for (let i = 0; i < size.albums; i++) yield album(i); }
  if (kind === 'boards') {
    for (let i = 0; i < size.memberships; i++) yield {
      _id: oid('board', i), boardId: uuid('board', i), userId: `bench-user-${Math.floor(i / 2)}`,
      title: i % 2 ? 'Favorites' : 'Saved albums', isDefault: i % 2 === 0,
      createdAt: EPOCH, updatedAt: EPOCH,
    };
  }
  if (kind === 'memberships') {
    for (let i = 0; i < size.memberships; i++) yield {
      _id: oid('membership', i), boardId: oid('board', i), userId: `bench-user-${Math.floor(i / 2)}`,
      albumCatalogId: oid('album', activityAlbum(Math.floor(i / 2), size.albums)), savedAt: EPOCH,
    };
  }
  if (kind === 'reviews') {
    for (let i = 0; i < size.reviews; i++) yield {
      _id: oid('review', i), reviewId: uuid('review', i), userId: `bench-user-${i % (size.memberships / 2)}`,
      albumCatalogId: oid('album', activityAlbum(i, size.albums)),
      reviewText: `Synthetic review ${i}: a memorable arrangement, textured production and a thoughtful sequence of songs.`,
      rating: 1 + (i % 9) / 2, date: new Date(EPOCH.getTime() - i * 60000), interactionRevision: 0,
    };
  }
}
async function seed(preset) {
  const registered = models();
  const checksum = crypto.createHash('sha256');
  const counts = {};
  for (const [kind, Model] of Object.entries(registered)) {
    if (await Model.countDocuments({})) throw new Error('Benchmark database must be empty');
    let batch = [];
    let count = 0;
    for (const row of rows(kind, preset)) {
      const error = new Model(row).validateSync();
      if (error) throw error;
      checksum.update(`${kind}:${JSON.stringify(row)}\n`);
      batch.push(row);
      count++;
      if (batch.length === 1000) { await Model.collection.insertMany(batch); batch = []; }
    }
    if (batch.length) await Model.collection.insertMany(batch);
    await Model.createIndexes();
    counts[kind] = await Model.countDocuments({});
    if (counts[kind] !== count) throw new Error(`Seed count mismatch: ${kind}`);
  }
  const indexes = {};
  for (const [kind, Model] of Object.entries(registered)) indexes[kind] = await Model.collection.indexes();
  return { preset, seed: SEED, epoch: EPOCH.toISOString(), checksum: checksum.digest('hex'), counts, indexes };
}
module.exports = { PRESETS, SEED, rows, album, uuid, oid, activityAlbum, models, seed };
