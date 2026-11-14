#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { parse } = require('espree');
const roots = ['frontend/src', 'routes'];
const delegatedRoutes = new Set(['routes/artistBiographyModeration.js', 'routes/commentModeration.js']);
const serverPackages = new Set(['express', 'mongoose', 'mongodb', 'dotenv', '@clerk/express', '@clerk/backend']);
const httpPackages = new Set(['http', 'https', 'http2', 'undici', 'axios', 'node-fetch', 'got', 'superagent']);
const databasePackages = new Set(['mongoose', 'mongodb']);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function literal(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}
function member(node) {
  return node?.type === 'MemberExpression' ? (node.computed ? literal(node.property) : node.property.name) : null;
}
function packageName(specifier) {
  const name = specifier.replace(/^node:/, '');
  return name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
}
function inspectSource(file, source) {
  file = file.replaceAll('\\', '/');
  const frontend = file.startsWith('frontend/src/');
  const route = file.startsWith('routes/');
  if (!frontend && !route) return [];
  const findings = [];
  const report = (node, rule, message) => findings.push({ file, line: node.loc.start.line, rule, message });
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: frontend || file.endsWith('.mjs') ? 'module' : 'commonjs', loc: true, ecmaFeatures: { jsx: true } });
  } catch (error) {
    return [{ file, line: error.lineNumber || 1, rule: 'ARCH_PARSE', message: `Cannot check source: ${error.message}` }];
  }
  walk(ast, node => {
    let sourceNode;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) sourceNode = node.source;
    if (node.type === 'ImportExpression') sourceNode = node.source;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') sourceNode = node.arguments[0] || node;
    if (sourceNode) {
      const specifier = literal(sourceNode);
      if (specifier === null) {
        report(node, 'ARCH_LITERAL', 'Use a literal module specifier so this boundary can be checked.');
      } else {
        const normalized = specifier.replaceAll('\\', '/');
        const pkg = packageName(normalized);
        const target = normalized.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), normalized)) : normalized;
        if (frontend && (
          (normalized.startsWith('.') && !target.startsWith('frontend/')) ||
          (normalized.startsWith('/') && !path.posix.normalize(normalized).startsWith('/src/')) ||
          /^(node:|file:|[a-z]:\/)/i.test(normalized) || builtins.has(pkg) || serverPackages.has(pkg)
        )) report(node, 'ARCH_FRONTEND', `Frontend cannot import server/outside-package module "${specifier}". Keep browser code in frontend; call the API for server behavior.`);
        if (route && httpPackages.has(pkg)) report(node, 'ARCH_ROUTE_NETWORK', `Route cannot import HTTP client "${specifier}". Put remote I/O behind a lib adapter/service and import that boundary.`);
        if (delegatedRoutes.has(file) && (databasePackages.has(pkg) || (target === 'models' || target.startsWith('models/')))) {
          report(node, 'ARCH_DELEGATED_PERSISTENCE', `This route delegates persistence; do not import "${specifier}". Use its existing biography/comment moderation service.`);
        }
      }
    }
    if (route && node.type === 'CallExpression' && (
      (node.callee.type === 'Identifier' && node.callee.name === 'fetch') ||
      (member(node.callee) === 'fetch' && node.callee.object.type === 'Identifier' && ['global', 'globalThis'].includes(node.callee.object.name))
    )) report(node, 'ARCH_ROUTE_NETWORK', 'Route cannot call fetch directly. Put remote I/O behind a lib adapter/service.');
  });
  return findings;
}
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Architecture scan refuses symlink: ${file}`);
    return entry.isDirectory() ? filesIn(file) : /\.(?:[cm]?js|jsx)$/.test(file) ? [file] : [];
  });
}
function checkProject(cwd) {
  const findings = [];
  let count = 0;
  for (const root of roots) {
    for (const file of filesIn(path.join(cwd, root))) {
      count++;
      findings.push(...inspectSource(path.relative(cwd, file), fs.readFileSync(file, 'utf8')));
    }
  }
  return { findings, count };
}
function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run check:architecture\nScans frontend/src and routes for direct import/network boundaries.\nRules: ARCH_FRONTEND, ARCH_ROUTE_NETWORK, ARCH_DELEGATED_PERSISTENCE, ARCH_LITERAL, ARCH_PARSE.\nSee docs/VERIFICATION.md#targeted-architecture-rules for scope, remediation, and limitations.');
    return;
  }
  try {
    const { findings, count } = checkProject(path.resolve(__dirname, '..'));
    for (const finding of findings) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    if (findings.length) process.exitCode = 1;
    else console.log(`Architecture boundaries clean: ${count} source files checked. Static boundaries do not prove authorization or concurrency safety.`);
  } catch (error) { console.error(`Architecture check unavailable: ${error.message}`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { inspectSource, checkProject };
