// The helper invokes only the API, bound to loopback. It never starts a listening worker.
const path = require('node:path');

const DEV_DATABASE = /^rescened_dev(?:_[a-z0-9]+)*$/;
// The one index artist pages need: sparse, non-unique, on credit artist IDs.
const ARTIST_INDEX = { collection: 'albumcatalogs', key: { 'artistCredits.artistId': 1 }, name: 'artistCredits.artistId_1' };

// Messages from this class are safe to print: they never include a URI or credential.
class PreviewSetupError extends Error {}

function sameKey(actual, expected) {
  return JSON.stringify(actual || {}) === JSON.stringify(expected);
}

// Artist-pages preview: connect with automatic collection and index creation
// off, confirm the connected database is the profile's development database,
// then ensure only the artist index. An existing index is reused; a
// conflicting one stops startup and is never dropped.
async function connectForArtistPreview(uri, { mongoose, expectedDatabase, log = console.log }) {
  if (!DEV_DATABASE.test(expectedDatabase || '')) throw new PreviewSetupError('Artist preview needs a rescened_dev database name from the profile.');
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const actual = db?.databaseName;
  if (actual !== expectedDatabase) {
    await mongoose.disconnect();
    throw new PreviewSetupError('Connected database does not match the profile database; nothing was written.');
  }
  log(`Artist preview database verified: ${actual}. Automatic collection/index creation is off.`);
  const collection = db.collection(ARTIST_INDEX.collection);
  const indexes = await collection.indexes();
  const existing = indexes.find((index) => index.name === ARTIST_INDEX.name || sameKey(index.key, ARTIST_INDEX.key));
  if (existing) {
    if (existing.name !== ARTIST_INDEX.name || !sameKey(existing.key, ARTIST_INDEX.key) || existing.sparse !== true || existing.unique) {
      await mongoose.disconnect();
      throw new PreviewSetupError(`An index named ${existing.name} conflicts with the artist preview index; it was left unchanged.`);
    }
    log(`Artist preview index ${ARTIST_INDEX.collection}.${ARTIST_INDEX.name}: already present (no change).`);
    return { created: false };
  }
  await collection.createIndex(ARTIST_INDEX.key, { name: ARTIST_INDEX.name, sparse: true });
  log(`Artist preview index ${ARTIST_INDEX.collection}.${ARTIST_INDEX.name}: created (sparse, non-unique).`);
  return { created: true };
}

function main(env = process.env) {
  const artistPreview = env.RESCENED_PREVIEW_INIT === 'artist-pages';
  let mongoose;
  if (artistPreview) {
    // Before server.js compiles any model, so no model initializes collections or indexes.
    mongoose = require('mongoose');
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  const { app, startServer } = require(path.resolve(process.argv[2]));
  return startServer({
    ...(artistPreview ? { connect: (uri) => connectForArtistPreview(uri, { mongoose, expectedDatabase: env.RESCENED_PREVIEW_DATABASE }) } : {}),
    listen: (port, callback) => app.listen(port, '127.0.0.1', callback),
  }).catch((error) => {
    // Avoid printing credential-bearing connection errors.
    console.error(error instanceof PreviewSetupError
      ? `Worktree API startup stopped: ${error.message}`
      : 'Worktree API startup failed. Check the approved development profile and database availability.');
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { ARTIST_INDEX, PreviewSetupError, connectForArtistPreview, main };
