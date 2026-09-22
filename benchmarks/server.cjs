// Only launched by the isolated runner. Never imported by server.js.
const fs = require('node:fs');
const Module = require('node:module');
const express = require('express');
const mongoose = require('mongoose');

function assertLocalUri(uri) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/rescened_bench_[a-z0-9_]+(?:\?|$)/.test(uri || '')) {
    throw new Error('Only a runner-owned loopback benchmark database is allowed');
  }
}
function createApp(source) {
  // Module substitutions are confined to this dedicated child process.
  // Retain real limiter exports for separately testing production budgets.
  const limiter = require('../routes/utils/rateLimit');
  require.cache[require.resolve('../routes/utils/rateLimit')].exports = {
    ...limiter, searchRateLimit: (_req, _res, next) => next(),
  };
  const clerkPath = require.resolve('@clerk/express');
  require(clerkPath);
  require.cache[clerkPath].exports = {
    getAuth: () => ({ userId: null }),
    clerkClient: { users: { getUserList: () => { throw new Error('Clerk is excluded from local capacity tests'); } } },
  };
  const searchPath = require.resolve('../routes/search');
  const search = new Module(searchPath, module);
  search.filename = searchPath;
  search.paths = Module._nodeModulePaths(require('node:path').dirname(searchPath));
  search._compile(source, searchPath);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/health', require('../routes/health'));
  // An exact method/path allowlist excludes all writes and provider endpoints.
  app.use((req, res, next) => {
    const paths = [
      /^\/search\/search$/, /^\/albums\/catalog$/,
      /^\/albums\/album\/[0-9a-f-]+(?:\/social)?$/,
      /^\/reviews\/(?:popular|recent-albums)$/,
    ];
    return req.method === 'GET' && paths.some((p) => p.test(req.path)) ? next() : res.sendStatus(404);
  });
  app.use('/search', search.exports);
  app.use('/albums', require('../routes/album'));
  app.use('/reviews', require('../routes/reviews'));
  return app;
}
async function main() {
  if (!process.send) throw new Error('Launch this server through the benchmark runner');
  const [uri, sourcePath] = process.argv.slice(2);
  assertLocalUri(uri);
  await mongoose.connect(uri, { autoIndex: false, maxPoolSize: 100 });
  const app = createApp(fs.readFileSync(sourcePath, 'utf8'));
  const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    await mongoose.disconnect();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
}
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
module.exports = { assertLocalUri };
