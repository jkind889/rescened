// Vite's listen() treats port 0 as its default port. Bind Node's HTTP server
// directly instead, keeping Vite in middleware mode and the OS port reservation.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const frontendRequire = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
async function createFixtureServer(options) {
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  // Vite 8 injects its client even with hmr/ws disabled (CSS uses its style
  // helpers). Keep those helpers, but remove the automatic HMR connection.
  // Fail closed if the locked Vite client changes instead of masking errors.
  const noHmrClient = {
    name: 'fixture-no-hmr-client', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').split('?')[0].endsWith('/vite/dist/client/client.mjs')) return;
      const connect = 'transport.connect(createHMRHandler(handleMessage));';
      if (code.split(connect).length !== 2) throw new Error('Fixture HMR client guard needs review for this Vite version.');
      return { code: code.replace(connect, '/* fixture: automatic HMR connection disabled */'), map: null };
    },
  };
  const vite = await createServer({ ...options, plugins: [...(options.plugins || []), noHmrClient], server: { ...options.server, middlewareMode: true, hmr: false, ws: false } });
  const httpServer = http.createServer(vite.middlewares);
  return {
    httpServer,
    async listen() {
      await new Promise((resolve, reject) => {
        const failed = error => { httpServer.removeListener('listening', ready); reject(error); };
        const ready = () => { httpServer.removeListener('error', failed); resolve(); };
        httpServer.once('error', failed); httpServer.once('listening', ready);
        httpServer.listen({ host: '127.0.0.1', port: 0 });
      });
    },
    async close() {
      try {
        if (httpServer.listening) await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      } finally { await vite.close(); }
    },
  };
}
module.exports = { createFixtureServer };
