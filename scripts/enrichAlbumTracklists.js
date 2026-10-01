#!/usr/bin/env node
const fs = require('node:fs');
const mongoose = require('mongoose');
const { preparePlan, summarizePlan, verifyPlan, applyPlan, digest, targetFingerprint } = require('../lib/baselines/backfill');
function parseArgs(args) {
  const options = { mode: 'dry-run', limit: 20 };
  let modeSeen = false;
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (['--dry-run', '--apply'].includes(key)) {
      if (modeSeen) throw new Error('ONE_MODE_REQUIRED');
      options.mode = key.slice(2); modeSeen = true;
    } else if (['--environment', '--confirm-environment', '--output', '--plan', '--sha256', '--reviewer', '--limit', '--after'].includes(key)) {
      if (options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      options[key] = args[++i];
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (!/^[\w-]{1,80}$/.test(options['--environment'] || '')) throw new Error('NAMED_ENVIRONMENT_REQUIRED');
  options.limit = Number(options['--limit'] || 20);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('INVALID_LIMIT');
  if (options['--after']) require('../lib/listening/common').assertPublicAlbumId(options['--after']);
  if (options.mode === 'dry-run' && !options['--output']) throw new Error('OUTPUT_REQUIRED');
  if (options.mode === 'apply' && (!options['--plan'] || !options['--sha256'] || !options['--reviewer'] || options['--confirm-environment'] !== options['--environment'])) throw new Error('EXPLICIT_APPLY_CONFIRMATION_REQUIRED');
  return options;
}
// Dry runs must not write the production provider cache or request-budget collection.
function privateProviderOptions() {
  const rows = new Map(); let nextAt = 0;
  return {
    gate: async () => { await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextAt - Date.now()))); nextAt = Date.now() + 1100; },
    cache: {
      findOne: ({ key }) => ({ lean: async () => rows.get(key) || null }),
      updateOne: async ({ key }, update) => { rows.set(key, update.$set); },
    },
    onRetryAfter: async () => {},
  };
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI_REQUIRED');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const service = require('../lib/baselines/service');
    const fingerprint = targetFingerprint(mongoose.connection);
    if (options.mode === 'dry-run') {
      const albums = await require('../models/AlbumCatalog').find({ releaseType: { $in: ['album', 'ep'] }, ...(options['--after'] ? { albumId: { $gt: options['--after'] } } : {}) }).sort({ albumId: 1 }).limit(options.limit).lean();
      const provider = require('../lib/baselines/musicBrainz').createBaselineMusicBrainz(privateProviderOptions());
      const plan = await preparePlan({ albums, environment: options['--environment'], fingerprint, provider, baselineForAlbum: service.baselineForAlbum });
      const bytes = JSON.stringify(plan, null, 2) + '\n';
      fs.writeFileSync(options['--output'], bytes, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ mode: 'dry-run', environment: plan.environment, ...summarizePlan(plan), sha256: digest(bytes), nextAfter: albums.at(-1)?.albumId || null }));
    } else {
      if (fs.statSync(options['--plan']).size > 10_000_000) throw new Error('ENRICHMENT_PLAN_TOO_LARGE');
      const bytes = fs.readFileSync(options['--plan'], 'utf8');
      const plan = verifyPlan(bytes, options['--sha256'], options['--environment'], fingerprint);
      await Promise.all(Object.values(require('../models/AlbumBaseline')).map((model) => model.createIndexes()));
      const result = await applyPlan(plan, { mongoose, reviewer: options['--reviewer'], planHash: options['--sha256'], queueCandidate: service.queueEnrichmentCandidate });
      console.log(JSON.stringify({ ...result, sha256: options['--sha256'] }));
    }
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch((error) => { console.error(/^[A-Z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'TRACKLIST_ENRICHMENT_FAILED'); process.exitCode = 1; });
module.exports = { parseArgs, privateProviderOptions, main };
