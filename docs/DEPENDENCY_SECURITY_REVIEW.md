# Dependency/security review — 2026-11-14

Snapshot against base commit `82c0014` in `verification-current`. Advisory evidence is the public npm registry audit response fetched on this date, for each separate lockfile both with and without development dependencies. This is a bounded dependency and code-exposure review, not an application penetration test, deployed-runtime assessment, or assurance that no vulnerabilities exist. Audits are intentionally separate from the offline verification gate; no CI/security settings were changed.

## Outcome and scope

| Lockfile audit | Before | After |
| --- | --- | --- |
| Root, all | 10 affected packages: 2 critical, 5 high, 3 moderate | 2 moderate packages: minimatch and its parent nodemon; audit exit 1 |
| Root, omit dev | 6 affected packages: 2 critical, 3 high, 1 moderate | 0; audit exit 0 |
| Frontend, all | 12 affected packages: 10 high, 2 moderate | 0; audit exit 0 |
| Frontend, omit dev | 2 high packages: react-router and react-router-dom | 0; audit exit 0 |

These are affected-package counts including parent/metavulnerability entries, not distinct advisories, exploit counts, or proof of reachability. Frontend omit-dev still does not classify what ships in a static bundle; code context below supplies that distinction.

Direct minimums raised within existing majors: compression 1.8.1 → 1.8.2; Mongoose 9.6.2 → 9.11.4; React Router DOM locked 7.18.0 → 7.18.2 (declared minimum was 7.14.0); Vite locked 8.0.16 → 8.1.6 (declared minimum was 8.0.1). Named transitive packages were refreshed within compatible declared ranges, without overrides or audit fix --force. Their normal dependency resolution includes MongoDB 7.2.0 → 7.7.0/BSON 7.2.0 → 7.3.4 and Rolldown 1.0.3 → 1.1.8/platform bindings; it also refreshes compiler browser data and supporting packages. Both lockfiles contain the full resolved diff. No production source changed.

## Findings, paths and remediation

The versions below are the reviewed locked versions, not recommendations to install the latest major. Each ID links to its advisory. Parent-only audit entries (Express, nodemon, react-router-dom) are represented by their affected dependency paths rather than counted again.

### Root API and development dependencies

**express → body-parser** — 2.2.2 → 2.4.0. API request parsing: global express.json() runs before authentication/rate limiting. The default options do not demonstrate the invalid-limit precondition; compressed-body handling is reachable.

- [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) (low): body-parser vulnerable to denial of service when invalid limit value silently disables size enforcement. Affected range: `>=2.0.0 <2.3.0`.
- [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (high): body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body. Affected range: `>=2.0.0 <2.4.0`.

**compression (direct)** — 1.8.1 → 1.8.2. API response compression is installed globally; premature connection close is relevant to the response lifecycle.

- [GHSA-vc2v-76pw-4v95](https://github.com/advisories/GHSA-vc2v-76pw-4v95) (high): compression vulnerable to Denial of Service via memory leak on premature response close. Affected range: `<1.8.2`.

**ajv → fast-uri** — 3.1.5 → 3.1.9. Catalog validation uses checked-in local schemas with no remote loadSchema resolver. URI-equivalence flaws are not demonstrated as a provider/network authorization bypass here.

- [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8) (high): fast-uri vulnerable to host confusion via skipped IDN canonicalization on scheme-relative references. Affected range: `>=3.1.3 <3.1.6`.
- [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) (high): fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization. Affected range: `>=3.0.0 <3.1.6`.
- [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) (high): fast-uri vulnerable to server-side request forgery via repeated hostname percent-decoding. Affected range: `>=3.1.2 <3.1.6`.
- [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) (high): fast-uri vulnerable to host confusion via percent-encoded scheme normalization. Affected range: `>=3.0.0 <3.1.6`.
- [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) (high): fast-uri vulnerable to authority injection via an unvalidated port in serialize. Affected range: `>=3.0.0 <3.1.7`.
- [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) (moderate): fast-uri vulnerable to inconsistent host case normalization via percent-encoded octets. Affected range: `>=3.0.0 <3.1.8`.
- [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) (moderate): fast-uri vulnerable to URI scheme spoofing via percent-encoded scheme decoding. Affected range: `>=3.0.0 <3.1.9`.
- [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h) (low): fast-uri vulnerable to improper path equivalence in relative reference normalization. Affected range: `>=3.0.0 <3.1.9`.
- [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) (moderate): fast-uri vulnerable to host confusion via unchecked WHATWG host canonicalization. Affected range: `>=3.1.3 <3.1.9`.
- [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) (low): fast-uri vulnerable to scheme injection via an unescaped first-segment colon in suffix references. Affected range: `>=3.0.0 <3.1.9`.

**express → proxy-addr** — 2.0.7 → 2.0.8. API proxy handling uses a numeric hop count from getTrustProxyHops(), not subnet trust rules. The advisory subnet precondition is not demonstrated; deployed proxy configuration was not inspected.

- [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical): proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet. Affected range: `>=1.1.0 <2.0.8`.

**express → qs; express → body-parser → qs** — 6.15.2 → 6.17.1. HTTP parsing dependency. The reviewed JSON middleware does not itself exercise every qs parse/stringify option in these advisories.

- [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) (moderate): qs array-limit bypass via bracket-key comma parsing. Affected range: `>=6.14.2 <=6.15.3`.
- [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) (moderate): qs: Denial of Service via Attacker Controlled isBuffer. Affected range: `>=2.2.5 <6.16.0`.
- [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) (moderate): qs : qs.stringify with arrayFormat 'comma' throws an uncaught TypeError on array elements carrying a non-callable own toString (DoS). Affected range: `>=6.7.0 <=6.16.0`.

**mongoose (direct)** — 9.6.2 → 9.11.4. Pervasive API model/query dependency. No discriminator(), .virtual(), or sanitizeFilter uses found in models/routes. This search does not prove malicious query/update input cannot reach affected internals.

- [GHSA-664h-wqgq-64gw](https://github.com/advisories/GHSA-664h-wqgq-64gw) (moderate): Mongoose: Prototype pollution in mongoose update casting via __proto__-prefixed dotted path (Schema._getSchema/path getter). Affected range: `>=9.0.0 <9.7.2`.
- [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c) (high): Mongoose: Connection-level sanitizeFilter not applied. Affected range: `>=9.0.0 <9.11.4`.
- [GHSA-pcrw-h46h-c93h](https://github.com/advisories/GHSA-pcrw-h46h-c93h) (critical): Mongoose: sanitizeFilter not applied on countDocuments. Affected range: `>=9.0.0 <9.9.2`.
- [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96) (moderate): Mongoose: Discriminator key values matching inherited properties (e.g. __t: 'constructor') bypass schema casting and can poison collections. Affected range: `>=9.0.0 <9.11.4`.
- [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4) (high): Mongoose walks into inherited properties when hydrating, setting, and merging, allowing overwrites of built-in functions (denial of service) and shared schema state. Affected range: `>=9.0.0 <9.11.4`.
- [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj) (moderate): Mongoose: Prototype pollution via Schema.prototype.virtual(). Affected range: `>=9.0.0 <9.11.4`.

**mongodb-memory-server → mongodb-memory-server-core → follow-redirects** — 1.16.0 → 1.16.3. Development/test Mongo binary provisioning transport, not an API provider adapter. Normal gate runtime downloads are disabled.

- [GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8) (high): follow-redirects array-form headers bypass cross-origin credential stripping. Affected range: `>=1.16.0 <1.16.1`.
- [GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c) (high): follow-redirects sensitiveHeaders regex escaping can expose credential headers. Affected range: `>=1.16.0 <1.16.1`.
- [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p) (high): follow-redirects: Cross-realm sensitiveHeaders arrays are discarded and custom credentials can follow redirects. Affected range: `>=1.16.0 <=1.16.1`.

**nodemon → minimatch → brace-expansion** — 5.0.6 → 5.0.13. Development file-watcher glob handling. No untrusted public glob input path demonstrated.

- [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) (high): brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups. Affected range: `>=3.0.0 <5.0.7`.
- [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (high): brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash. Affected range: `>=4.0.0 <5.0.8`.
- [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) (high): brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation. Affected range: `>=4.0.0 <5.0.9`.
- [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) (moderate): brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service. Affected range: `>=4.0.0 <5.0.12`.
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) (high): brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion. Affected range: `>=4.0.0 <5.0.11`.
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high): brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion. Affected range: `>=4.0.0 <5.0.10`.

**nodemon → minimatch** — 10.2.4 → 10.2.4 (unresolved). RESIDUAL: development watcher globparts amplification; not used by npm start or the verification gate.

- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (moderate): minimatch has potential denial of service via globparts amplification. Affected range: `>=7.0.0 <11.0.1`.

### Frontend runtime and tooling

**react-router-dom → react-router** — 7.18.0 → 7.18.2. Browser-delivered runtime dependency, but the advisory targets RSC server actions. App.jsx uses BrowserRouter; no RSC action server found in the reviewed application.

- [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) (high): React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response. Affected range: `>=7.12.0 <7.18.2`.

**vite (direct devDependency)** — 8.0.16 → 8.1.6. Local development/build/fixture tooling. Editor launch, middleware and filesystem exposure matter to dev servers; these are not production browser-bundle endpoints. Fixture helper keeps loopback ephemeral HTTP and ws:false.

- [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) (moderate): launch-editor: escapeCmdArgs() omits % escaping on Windows. Affected range: `>=8.0.0 <=8.1.5`.
- [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) (moderate): launch-editor: Editor CLI flag misinterpretation causing arbitrary command execution for some editors. Affected range: `>=8.0.0 <=8.1.5`.
- [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high): launch-editor: `fs.existsSync()` existence check can be bypassed on Windows. Affected range: `>=8.0.0 <=8.1.5`.
- [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) (low): Vite: Cross origin script execution through Vite custom middleware. Affected range: `>=8.0.0 <=8.1.5`.
- [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) (moderate): Vite: Files outside `server.fs.allow` could be served when project paths match system paths on non-Windows machine. Affected range: `>=8.0.0 <=8.1.5`.

**vite → postcss** — 8.5.15 → 8.5.33. Build-time CSS/source-map processing; potential local .map disclosure with malicious build inputs.

- [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) (moderate): PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset. Affected range: `<=8.5.22`.
- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (high): PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure. Affected range: `<=8.5.17`.

**vite → postcss → nanoid** — 3.3.15 → 3.3.20. Tooling generator edge cases, not a demonstrated application request path.

- [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) (high): nanoid: non-secure generators can loop indefinitely with negative size. Affected range: `<3.3.16`.
- [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) (high): nanoid: custom generators can loop indefinitely when size is zero. Affected range: `<3.3.18`.

**vite → postcss → source-map-js** — 1.2.1 → 1.2.2. Tooling source-map processing; malicious indexed map input can block the process.

- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high): source-map-js allows event-loop denial of service through indexed source-map section offsets. Affected range: `>=1.0.0 <1.2.2`.

**eslint → @humanfs/node** — 0.16.7 → 0.16.8. Lint filesystem utility; recursive-copy symlink behavior is not demonstrated in the current lint invocation.

- [GHSA-p498-v437-472g](https://github.com/advisories/GHSA-p498-v437-472g) (moderate): humanfs: Recursive copy follows symlinked files and copies data from outside the source tree. Affected range: `<0.16.8`.

**eslint → @eslint/eslintrc → js-yaml** — 4.2.0 → 4.3.2. Lint configuration parser; repository ESLint config is ESM JavaScript, not user-supplied YAML.

- [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) (high): js-yaml: YAML merge-key chains can force quadratic CPU consumption. Affected range: `>=4.0.0 <4.3.0`.
- [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) (high): JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported. Affected range: `>=4.0.0 <4.3.1`.
- [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) (high): js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources. Affected range: `>=4.0.0 <4.3.2`.

**eslint → minimatch → brace-expansion** — 1.1.13 → 1.1.22. Lint glob expansion; checked-in patterns are the normal inputs.

- [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) (high): brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups. Affected range: `<1.1.16`.
- [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (high): brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash. Affected range: `<1.1.17`.
- [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) (high): brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation. Affected range: `<1.1.18`.
- [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) (moderate): brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service. Affected range: `<1.1.21`.
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) (high): brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion. Affected range: `<1.1.20`.
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high): brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion. Affected range: `<1.1.19`.

**eslint-plugin-react-hooks → @babel/core → @babel/helper-compilation-targets → browserslist** — 4.28.2 → 4.29.5. Lint/compiler target queries/custom statistics, not browser request input.

- [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) (high): Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM. Affected range: `<=4.28.6`.
- [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) (high): Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats). Affected range: `<=4.28.6`.

**browserslist → baseline-browser-mapping** — 2.10.38 → 2.11.37. Tooling lookup termination on invalid inputs; no application input path demonstrated.

- [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) (moderate): baseline-browser-mapping process termination on invalid input causes denial of service. Affected range: `>=2.0.0 <2.11.0`.

**eslint-plugin-react-hooks → zod (also zod-validation-error)** — 4.3.6 → 4.6.7. Lint/compiler validation of oversized constrained collections; not the API validator.

- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high): Zod can exhaust memory while validating oversized constrained collections. Affected range: `<4.6.6`.

## Remaining decisions and exact limits

- **minimatch GHSA-g3hv-75wg-m249:** locked 10.2.4 remains affected (>=7, <11.0.1); nodemon 3.1.14 is its development-only parent. npm proposes nodemon 3.1.11, a downgrade outside the declared ^3.1.14 range. No downgrade or minimatch 11 override was applied. Proposed follow-up: wait for a compatible nodemon release with the fix, or explicitly approve and test a minimatch 11 override/removal of the optional nodemon workflow. Public API exploitability is not established; audit all still fails and this is not blanket risk acceptance.
- **Node:** validation deliberately uses the requested /usr/local/bin/node v22.16.0 with npm 10.9.2. The official [release schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) places Node 22 in maintenance through 2027-04-30; the [release index](https://nodejs.org/dist/index.json) returned v22.23.5 dated 2026-11-11 with security:true. Supported major does not mean this older patch is current. Recommend a separately reviewed runtime patch rollout and rerun on its exact version; no shared runtime or CI version was altered. Patched Mongoose/MongoDB require >=20.19 and Vite/Rolldown require ^20.19 or >=22.12, which 22.16 satisfies.
- **Unknowns:** deployed versions, edge/proxy topology, secret handling and provider configuration were not inspected. The audit is advisory matching, not source provenance attestation or malware analysis. Published tarball integrity is not proof of trustworthy publisher behavior. Transitive call reachability, hostile plugin/build inputs, all OS-specific paths and future advisories remain outside this snapshot. Local macOS verification does not replace Linux CI. No live provider or shared database was contacted.

## Lock and installation hygiene

Both package projects retain independent npm v3 lockfiles, with matching root manifests. Every non-root locked entry has integrity and a public registry.npmjs.org tarball URL; no git, local-file or linked source entries were found. Separate clean npm ci --ignore-scripts --no-audit --no-fund installs succeeded; npm ls --all exited 0 for both packages. Optional platform dependencies are retained in the locks; only the current platform was exercised.

Lifecycle entries remain the two nested @clerk/shared 4.13.1 packages, mongodb-memory-server 10.4.3, root fsevents 2.3.3 and Playwright's nested fsevents 2.3.2, plus frontend fsevents 2.3.3. Inspected Clerk postinstall code can write its telemetry notice preference under the home directory; Mongo postinstall can download binaries; native optional packages have their own setup scripts. Installs deliberately skipped all of them. This review does not approve enabling scripts globally. Chromium and the cached Mongo 7.0.24 binary were pre-existing explicit prerequisites, with Mongo runtime downloads disabled during tests.

The existing Verification workflow already uses separate script-disabled installs, pinned action commit SHAs, contents:read, no persisted checkout credential, and separate explicit Mongo provisioning. This milestone adds no online audit requirement to that offline test gate. For future isolated reviews, use a public-registry audit with npm user config disabled and no inherited credentials; retain the JSON and exit status even when the audit is nonzero.

## Validation and reproducibility

Evidence directory for this run: /tmp/rescened-security-review (local temporary files, not committed). Raw before-*.json and root-all/root-prod/frontend-all/frontend-prod.json retain exact advisory ranges, severities, paths and audit responses; hygiene.json records changed versions, engines and lifecycle entries. Online audits used --package-lock-only --ignore-scripts --json --registry=https://registry.npmjs.org, with --omit=dev for production views. Both installs used the public registry with NPM_CONFIG_USERCONFIG=/dev/null and a task-specific temporary cache.

All checks use Node 22.16.0 and PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin from an env -i environment with only HOME retained. The gate applies its additional child sanitization. No credentials/.env, shared database or provider switches were supplied.

The first full-gate run exposed a fixture compatibility issue: BSON 7.3.4 returns a copy of ObjectId.id. The catalog-rediscovery harness mutated that copy and left timestamps at real time, causing 19 failures. The fixture now constructs an ObjectId from the modified bytes and asserts its synthetic timestamp. This preserves its same-second uniqueness and time-window assertions without weakening expectations or changing the worker. The focused rediscovery suite then passed 20/20. The original failed aggregate log is retained; a clean rerun is recorded below.

| Check | Final result | Evidence in /tmp/rescened-security-review |
| --- | --- | --- |
| Separate locked root/frontend installs | PASS, both exit 0; scripts disabled | ci-root.log; ci-frontend.log |
| Installed dependency trees / declared Node engines | PASS, npm ls --all exit 0 for both; no incompatible Node ranges | ls-root.json; ls-frontend.json; engines.json |
| Focused browser runner/server, architecture and gate regressions | PASS 40/40, zero skips | focused-sockets.log |
| Focused catalog rediscovery after fixture correction | PASS 20/20, zero skips | focused-rediscovery.log |
| Browser fixtures | PASS 11/11, zero skips, exit 0 | browser.log; /tmp/rescened-browser-1hu1pt/run.log |
| Final backend suite | PASS 1,149; 287 expected Mongo/live/browser opt-in skips; 1,436 total; zero failures | full-gate-final.log |
| Final disposable Mongo integration | PASS 345/345, zero skips | full-gate-final.log |
| Final catalog contract (including architecture), frontend lint, production build | PASS, all three stages | full-gate-final.log |
| Final npm run verify | PASS, exit 0 | full-gate-final.log |

The final aggregate emits 2,593 Mongoose validateSync() deprecation warnings (removal announced for Mongoose 10); these were not suppressed. Current production uses include routes/utils/albumCatalog.js, lib/artists/backfill.js, lib/listening/worker.js and lib/reviewObservations/episodes.js. Migrating synchronous validation to asynchronous calls is a separate behavior review before Mongoose 10; the current 9.x calls pass the executed checks. No unrelated migration was folded into this dependency patch.

Earlier attempts remain visible: focused.log exited 1 with 39 passes and one sandbox EPERM loopback-bind failure; focused-sockets.log passed with socket permission. full-gate.log exited 1 with 1,130 backend passes, 19 timestamp-fixture failures and 287 skips, followed by 345/345 integration passes and the other three stages passing. These are not intermittent errors retried until green: the final aggregate follows the specific fixture correction above. The browser tests exercise real components with synthetic local fixtures, not full application/Clerk E2E. Browser HTTP/WebSocket isolation and sanitized Playwright discovery code are unchanged.

Handoff contains the two manifests, two lockfiles, the timestamp fixture correction, this snapshot and its link in VERIFICATION.md. HEAD remains 82c0014 and all edits are unstaged for independent review. No Git mutations or publication were performed.
