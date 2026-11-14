const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createFixtureServer } = require('./browser-support/server');
let available = false;
try { require.resolve('vite', { paths: [path.resolve(__dirname, '../frontend')] }); available = true; } catch { /* Standalone backend tests need no frontend install. */ }
test('fixtures bind only ephemeral HTTP listeners, never Vite WebSocket port 24678, and close them', { skip: available ? false : 'Install locked frontend dependencies to test the Vite fixture server' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-server-'));
  const servers = [];
  const ports = [];
  const originalListen = net.Server.prototype.listen;
  // Observe attempted bindings as well as successful ones: Vite can otherwise
  // log a WebSocket collision without failing HTTP startup.
  net.Server.prototype.listen = function (...args) {
    ports.push(typeof args[0] === 'object' ? args[0].port : args[0]);
    return Reflect.apply(originalListen, this, args);
  };
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Ephemeral fixture</title><h1>Local fixture</h1>');
    for (let i = 0; i < 2; i++) {
      const server = await createFixtureServer({ configFile: false, envDir: false, root: directory, server: { watch: null } });
      servers.push(server); await server.listen();
      const address = server.httpServer.address();
      assert.equal(address.address, '127.0.0.1');
      assert.ok(address.port > 0);
      assert.notEqual(address.port, 5173);
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Local fixture/);
      const client = await (await fetch(`http://127.0.0.1:${address.port}/@vite/client`)).text();
      assert.match(client, /fixture: automatic HMR connection disabled/);
      assert.ok(!client.includes('transport.connect(createHMRHandler(handleMessage));'));
    }
    assert.notEqual(servers[0].httpServer.address().port, servers[1].httpServer.address().port);
    assert.deepEqual(ports, [0, 0], 'only Node ephemeral HTTP bindings; no 24678 WebSocket binding attempt');
  } finally {
    net.Server.prototype.listen = originalListen;
    await Promise.all(servers.map(server => server.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
  for (const server of servers) assert.equal(server.httpServer.listening, false);
});
