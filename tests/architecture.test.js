const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectSource, checkProject } = require('../scripts/checkArchitecture');
const fixtures = require('./fixtures/architecture/cases.json');
for (const fixture of fixtures) test(`architecture: ${fixture.name}`, () => {
  const findings = inspectSource(fixture.file, fixture.source);
  assert.deepEqual(findings.map(finding => finding.rule), fixture.rules);
  for (const finding of findings) {
    assert.equal(finding.file, fixture.file);
    assert.ok(finding.line >= 1);
    assert.ok(finding.message.length > 20);
  }
});
test('current source conforms without architecture exceptions or production edits', () => {
  const { findings, count } = checkProject(path.resolve(__dirname, '..'));
  assert.ok(count > 100);
  assert.deepEqual(findings, []);
});
test('catalog command enforces architecture recursively and fails closed when a scan root is missing', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-fixture-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const script = path.resolve(__dirname, '../scripts/checkCatalogContract.js');
  const run = () => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  fs.mkdirSync(path.join(cwd, 'frontend/src/nested'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'routes'));
  fs.writeFileSync(path.join(cwd, 'frontend/src/nested/example.jsx'), 'export default () => <p>Valid fixture</p>;');
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(cwd, 'frontend/src/nested/example.jsx'), "import db from '../../../../models/AlbumCatalog';");
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /frontend\/src\/nested\/example.jsx:1 \[ARCH_FRONTEND\]/);
  assert.match(invalid.stderr, /call the API/);
  fs.rmSync(path.join(cwd, 'routes'), { recursive: true });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Architecture check unavailable/);
});
