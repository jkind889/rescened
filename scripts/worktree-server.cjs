// The helper invokes only the API, bound to loopback. It never starts a listening worker.
const { app, startServer } = require(require('node:path').resolve(process.argv[2]));
startServer({ listen: (port, callback) => app.listen(port, '127.0.0.1', callback) }).catch(() => {
  // Avoid printing credential-bearing connection errors.
  console.error('Worktree API startup failed. Check the approved development profile and database availability.');
  process.exit(1);
});
