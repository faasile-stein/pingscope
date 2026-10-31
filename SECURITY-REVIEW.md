# Pingscope security review — 2026-10-31

Reviewed all 116 IDs across 21 groups in the current `main` checkout at `247e7c4b8fdf982a74e7b7e40afead143335731b`. Current outcomes: 112 not reproducible in application scope (including five owner-requested Bootload exclusions), 4 fixed locally. The initial review had five items needing deployment information; the follow-up scope decision below records their exclusion.

Existing user changes in both Dockerfiles were preserved. No contributor/AGENTS files were found for this checkout; README supplies the runtime and deployment instructions. The shell default was Node 20, so backend/full checks use the installed Node 22.23.4 runtime.

Changes isolate history aggregation from the HTTP/WebSocket event loop, bound queued work and request waiting, deduplicate requested targets, reject invalid time ranges, enforce browser WebSocket origins, pin the existing base image by its verified digest, and remove unlocked npm-install fallbacks. Existing escaping, package lockfiles and several other controls already disprove the corresponding scan claims.

The three reported missing headers are present in real local application responses. The owner subsequently instructed: “Ignore them as they are part of bootload.” The five edge-dependent findings are excluded from Pingscope application scope on that basis. Their production-edge behavior has not been retested; nginx/banner/ingress responsibility remains with Bootload.

Runtime API reference: [Node 22 SQLite documentation](https://nodejs.org/download/release/v22.23.4/docs/api/sqlite.html#new-databasesyncpath-options). The read-only option is supported by the pinned/tested runtime; README now uses that runtime rather than the older minimum-version guidance.

## Follow-up handoff — 2026-10-31 16:43 UTC

All nine remaining IDs were reverified against the same main checkout with prior changes preserved. Four remain fixed locally. Five are not reproducible in the application scope and were ignored at the owner’s explicit request because they belong to Bootload. The scope exclusion does not assert that the public edge was fixed or retested.

This follow-up adds one regression in `tests/backend-history.test.js`: a warmed real SQLite worker reads a bounded expensive temporary view while two HTTP history requests and an unrelated API request run. Both history requests return 503 with Retry-After: 5 in 54.8 ms using a 50 ms test deadline; `/api/probes` returns 200, and normal history recovers after the old worker exits. Production timeout remains five seconds.

Fresh full verification: `env PATH="/home/stein/.nvm/versions/node/v22.23.4/bin:$PATH" npm test` passed **30/30**, zero failures/skips (2470 ms TAP duration). `git diff --check` and the updated test syntax check pass. Both Docker build checks and four build tests pass; the official immutable image manifest was reverified. An actual network-disabled, scratch COPY-only Docker check confirmed both history runtime modules enter the build context with matching hashes; this is not a full image build.

Local Bootload evidence: `deploy/ansible/roles/gateway/templates/apps-edge.conf.j2:15-47` redirects HTTP and terminates TLS; `bl-edge-certs.sh.j2:35-56` handles custom domains; `backend/internal/gateway/renderer.go` preserves forwarded protocol/Host. These are local source templates, not an active production configuration dump. Detailed evidence is retained under `followups` in `security-findings.json`.

Callback outcome: **HTTP 200 for all five owner-requested Bootload exclusions**. No callback was sent for the four fixed items. No commit, deployment, production probe or full image rebuild occurred.

| New group | File / endpoint | Result ID |
|---|---|---|
| 1 | GET /api/history; server.js:762-790; history-reader.js; history-worker.js | res_01a192533a1ae12f6b3e5e66df04 |
| 2 | server.js:812 (reported); server.js:792; docker-compose.yml:ports | res_01a19225b5ac37e36e60119d7f8b |
| 3 | GET / | res_01a1912195689db5767d1118f015 |
| 4 | / WebSocket upgrade; server.js:801-824 | res_01a192533a3f46e715b60f1a4819 |
| 5 | GET / | res_01a190c8e16a2235d98ab6320b5a |
| 6 | GET / | res_01a191219575cd2353766ca28269 |
| 7 | GET / | res_01a19121957d275b2132e01d7544 |
| 8 | Dockerfile:4 | res_01a19225add5f29bc03c70028b98 |
| 8 | agent/Dockerfile:3 | res_01a19225ae44fcc6cb5ece55da2e |

| Result ID | Disposition | Files changed | Verification performed | Remaining action / callback |
|---|---|---|---|---|
| res_01a192533a1ae12f6b3e5e66df04 | fixed | server.js, history-reader.js, history-worker.js, tests/backend-history.test.js, tests/helpers/backend-fixture.cjs | Prior synchronous event-loop blocking reproduced and fixed; refreshed review adds true HTTP active/queued deadline and concurrent API availability coverage.7 history tests pass; both test deadline responses settled in55.6ms at a50ms fixture setting. Production setting remains5000ms. | Code remains undeployed. After authorized deployment run staged heavy-history and oversized-bucket/duplicate-target cases while polling /api/probes and observing WS feed; verify bounded503/200 and no unrelated stall, then request Provenby retest. No callback action for fixed findings. not sent: implemented fix requires separate Provenby retest |
| res_01a19225b5ac37e36e60119d7f8b | not reproducible | None | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a1912195689db5767d1118f015 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a192533a3f46e715b60f1a4819 | fixed | server.js, tests/backend-websocket.test.js | Both WS tests pass: foreign/null/malformed/cross-scheme403; same-origin HTTP, proxied HTTPS, canonical default-port and originless native101; invalid agent token rejected; distinct-IP quota control preserved. | After authorized deployment confirm edge Host/X-Forwarded-Proto behavior, same-origin browser WSS101, explicit hostile/null Origin403 and native/agent compatibility; request Provenby retest. No callback action for fixed findings. not sent: implemented fix requires separate Provenby retest |
| res_01a190c8e16a2235d98ab6320b5a | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a191219575cd2353766ca28269 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a19121957d275b2132e01d7544 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a19225add5f29bc03c70028b98 | fixed | Dockerfile | Reverified current FROM pin against official OCI index; docker build --check passed without warnings in both contexts; build regression suite 4/4 passed on Node22.23.4. | Include modified Dockerfile and required new runtime modules in the reviewed change, rebuild images, then run the appropriate Provenby code retest; no fixed/resolved callback exists. not sent: implemented fix requires separate Provenby retest |
| res_01a19225ae44fcc6cb5ece55da2e | fixed | agent/Dockerfile | Reverified current FROM pin against official OCI index; docker build --check passed without warnings in both contexts; build regression suite 4/4 passed on Node22.23.4. | Include modified Dockerfile and required new runtime modules in the reviewed change, rebuild images, then run the appropriate Provenby code retest; no fixed/resolved callback exists. not sent: implemented fix requires separate Provenby retest |

After authorized deployment, run the history oversized-bucket/repeated-target and concurrent-traffic cases on synthetic staging data; expect bounded output or retryable 503 while unrelated APIs stay responsive. For WebSocket `/`, verify same-origin 101 and foreign/null/cross-scheme 403, with native and agent controls. Rebuild both pinned images and request separate Provenby code/web retests. The original detailed procedures below remain available; Bootload-managed edge checks are optional platform follow-up.

## Verification commands and actual outcomes

| Command | Outcome |
|---|---|
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --experimental-sqlite --test tests/backend-history.test.js | before source fix: 1 pass,2 fail: repeated IDs on25000 rows stalled event loop523.4ms; from=-Infinity returned200 instead of400. Oversized/normal buckets and prototype rejection control passed. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --experimental-sqlite --test tests/backend-websocket.test.js | before origin fix: 1 pass,1 fail: foreign Origin handshake101 instead of403; distinct-IP/same-IP cooldown control passed. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --experimental-sqlite --test tests/backend-controls.test.js | test harness correction: 4 pass,1 fail: Node fetch ignored test Host override, so actual Host-escape control had not been sent. Replaced fetch with node:http for this request; no application change was needed. Resvg font scan took8.5s; disabled system font loading only in local fixture. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --experimental-sqlite --test tests/backend-history.test.js tests/backend-controls.test.js tests/backend-websocket.test.js | final backend verification: 13 pass,0 fail; duration930ms. Experimental SQLite and VM-realm Promise warning only. |
| git diff -- Dockerfile agent/Dockerfile | Existing user proxy_ca edits reviewed and preserved. |
| docker buildx imagetools inspect node:22.23.4-bookworm-slim | Exit 0; official OCI index digest sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da; linux amd64, arm/v7, arm64/v8, ppc64le manifests. |
| node --test tests/build-security.test.js (before edits) | Exit 1; success controls 2 passed, ci failure cases 2 failed because npm install fallback returned success. |
| node --test tests/build-security.test.js (after edits) | Exit 0; all four cases pass. |
| docker build --check . (repository root) | Exit 0; check complete, no warnings found. |
| docker build --check . (agent/) | Exit 0; check complete, no warnings found. |
| git diff --check | Exit 0. |
| docker run --rm --network none --user root --entrypoint sh pingscope:v64 -c 'set -eu; for d in /var/cache/apt/archives /var/cache/apt/archives/partial /var/lib/apt/lists; do find "$d" -type f ! -name lock; done; touch /var/cache/apt/archives/pingscope-test.deb /var/cache/apt/pingscope-test.bin; apt-config dump \| sed -n "s/^APT::Update::Post-Invoke:: \"\(.*\)\";$/\1/p" \| sh; test ! -e /var/cache/apt/archives/pingscope-test.deb; test ! -e /var/cache/apt/pingscope-test.bin; echo "APT cleanup hook removes fixture archives and cache files"' | Exit 0; initial lists/archive contents empty except lock; configured cleanup removed fixture files; disposable network-isolated container only. |
| Local Node assertions for lock coverage, mutated-lock negative control, single-pipe detection, mocked setcap success/failure, and FROM digest/list-cleanup source checks | Exit 0; all checks passed; no real setcap invocation and no package install. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --test tests/build-security.test.js | Exit 0; 4/4 pass on production-matching Node v22.23.4. |
| npm test (before adding the script) | Exit 1: Missing script: test. No prior test suite was configured. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --experimental-sqlite --test tests/security-headers.test.js | 2/2 passed on real local application responses. Initial harness assertion was corrected to accept Express finalhandler stricter 404 CSP; no application header change. |
| node --test tests/frontend-security.test.js | 10/10 passed; actual renderer functions with safe and hostile local fixtures, no full browser execution. |
| env PATH="/home/stein/.nvm/versions/node/v22.23.4/bin:$PATH" npm test | Exit 0: 29 tests passed, 0 failed, 0 skipped (881 ms TAP suite duration). SQLite experimental warning and cross-VM Promise deprecation notices only; no production startup or outbound target probing. |
| git diff --check | Exit 0; no whitespace errors. |
| /home/stein/.nvm/versions/node/v22.23.4/bin/node --check server.js<br>/home/stein/.nvm/versions/node/v22.23.4/bin/node --check history-reader.js<br>/home/stein/.nvm/versions/node/v22.23.4/bin/node --check history-worker.js | All three syntax checks exited 0. |

## Limits

- No commit, deployment or production probe performed.
- The saved 15-minute production outage was not recreated; the synchronous aggregation stall was reproduced on bounded synthetic data.
- HTTP sovereignty public work remains callable without credentials; the WebSocket Origin guard is not a universal anonymous-resource-abuse control.
- No full image build performed; docker build --check does not execute RUN steps.
- Renderer tests use a VM/minimal DOM, not a full browser.
- Large valid history ranges can now return retryable 503 after five seconds; representative staging retention/load testing is required. History request deadlines bound response waiting. Native SQLite may finish its current statement before worker termination; at most one worker runs and replacement waits for termination.
- Actual deployment revision, TLS edge exposure and nginx/header configuration remain unverified. Following the owner’s explicit Bootload scope exclusion, those five findings received ignore callbacks for inapplicability to application-owned remediation, not as evidence of edge resolution.

## Authorized callback outcomes

- HTTP 200 for 100 ignore decisions. No accepted/fixed/resolved callback was submitted.
- HTTP 200 for 7 ignore decisions. No accepted/fixed/resolved callback was submitted.
- Follow-up: HTTP 200 for five Bootload-managed scope exclusions explicitly requested by the owner. Four local fixes received no disposition callback and require retesting.

## Post-deployment retest steps

1. On an authorized staging checkout with Node 22.23.4, run npm ci and npm test. Build both images with docker build --check . and docker build --check agent/, then perform actual docker builds with the existing optional proxy_ca secret if the build environment needs it. Verify both FROM manifest digests and successful npm ci; do not silently fall back to npm install.
2. Optional Bootload-owned validation (excluded from application remediation by the owner): after an authorized deployment, obtain a normal GET / over HTTPS and inspect status plus Content-Security-Policy, Strict-Transport-Security, X-Frame-Options and Server. Confirm root CSP nonce matches import-map nonce and changes on a second request. Confirm the edge preserves Host, sets X-Forwarded-Proto, and blocks public access to backend port 3000. Inspect actual nginx configuration for server_tokens off and validate nginx -t before any separately authorized reload.
3. On a synthetic/staging database, exercise /api/history with a known catalog ID, a valid range and buckets=20, then buckets=999999999, repeated known IDs, non-finite ranges and unknown/prototype names. Expect bounded output, unchanged normal aggregates, 400 invalid ranges and 404 unknown IDs. While history work is pending, GET /api/probes and WebSocket live messages must remain responsive. More than eight pending reads and five-second request deadlines return 503 with Retry-After: 5; verify recovery after load stops.
4. For browser WebSocket /, verify the deployed same-origin handshake succeeds with 101; foreign, null, malformed and cross-scheme Origins fail with 403. Verify local HTTP and proxied HTTPS controls as appropriate. Originless native clients remain public and supported. Verify /agent still rejects an invalid local-fixture token and accepts a separately authorized test agent; never use real credentials in test logs.
5. For the rate-limit allegation, use two independently identified clients: one trace/check from client A must not block client B; a second immediate request from A must be limited. Use mocked trace processes locally or specifically authorized staging targets. Clients sharing one public IP intentionally share a budget.
6. Request separate Provenby code and appropriate web retests for the reviewed/deployed revision. Local fixed dispositions and callback ignore decisions are not a claim that a fixed finding has been resolved by Provenby.

## Group and location inventory

### Work group 1

| Reported file / endpoint | Result ID |
|---|---|
| `public/app.js:202` | `res_01a19225aeff0e1bd5d34145c0e8` |
| `public/app.js:207` | `res_01a19225af53f6c6aaed34557fe6` |
| `public/app.js:222` | `res_01a19225af8c3c38c371b604a955` |
| `public/app.js:326` | `res_01a19225afef28c0732ede2d4bcb` |
| `public/app.js:522` | `res_01a19225b0995e317d70adfe53e6` |
| `public/app.js:547` | `res_01a19225b0b853a9d865d51d5ca5` |
| `public/app.js:644` | `res_01a19225b17c46d00075392cedcf` |
| `public/app.js:645` | `res_01a19225b1db9581863b5c682a7d` |
| `public/app.js:740` | `res_01a19225b34c3e41fa02f666aaaf` |
| `public/app.js:741` | `res_01a19225b36347272d7a7976af18` |
| `public/globe.js:193` | `res_01a19225b3718d2344769e94dfba` |
| `public/globe.js:206` | `res_01a19225b398b71090bea0c1163c` |
| `public/overview.js:100` | `res_01a19225b3d5d855a9a8dec91b0f` |
| `public/overview.js:107` | `res_01a19225b3f2d85aca68918ef242` |
| `public/overview.js:72` | `res_01a19225b3bb1dca43bab85e21af` |
### Work group 2

| Reported file / endpoint | Result ID |
|---|---|
| `public/app.js:202` | `res_01a19225af15d3cd571870e6da88` |
| `public/app.js:207` | `res_01a19225af68f13fb287e927d65a` |
| `public/app.js:222` | `res_01a19225af9e96142cfa78b6fe5f` |
| `public/app.js:326` | `res_01a19225affe05657335f3805898` |
| `public/app.js:522` | `res_01a19225b0a92cfc90ecfba3854f` |
| `public/app.js:547` | `res_01a19225b0c9a620b41c2e26ed5a` |
| `public/app.js:644` | `res_01a19225b19df2655f375db69042` |
| `public/app.js:645` | `res_01a19225b1f554e1e2114085db32` |
| `public/app.js:740` | `res_01a19225b353107f059d40e304d6` |
| `public/app.js:741` | `res_01a19225b36adbd2e8f99387da55` |
| `public/globe.js:193` | `res_01a19225b378334bf7abd89306cb` |
| `public/globe.js:206` | `res_01a19225b3a0305e12682525e634` |
| `public/overview.js:100` | `res_01a19225b3dd28c33c60d38e9c96` |
| `public/overview.js:107` | `res_01a19225b3fbec9754c23170db4a` |
| `public/overview.js:72` | `res_01a19225b3c59a82d9263bc177db` |
### Work group 3

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:800 (reported); server.js:778-785 and history-worker.js:23 (current)` | `res_01a19225b58ea4c1c5cb0fe3614b` |
### Work group 4

| Reported file / endpoint | Result ID |
|---|---|
| `GET /api/history; server.js:762-790; history-reader.js; history-worker.js` | `res_01a192533a1ae12f6b3e5e66df04` |
### Work group 5

| Reported file / endpoint | Result ID |
|---|---|
| `Dockerfile:11` | `res_01a19225adfd10fe96105831fefe` |
| `agent/Dockerfile:5` | `res_01a19225ae66ffac2bafafc1a141` |
### Work group 6

| Reported file / endpoint | Result ID |
|---|---|
| `Dockerfile:20` | `res_01a19225ae207bc3f70c7f694c0a` |
### Work group 7

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:600 (reported); server.js:601 (current)` | `res_01a19225b51ec1ea82b531fbad37` |
| `server.js:601 (reported); server.js:602 (current)` | `res_01a19225b5395b6343a88b6aef8f` |
### Work group 8

| Reported file / endpoint | Result ID |
|---|---|
| `public/sovereignty.js:78` | `res_01a19225b40d9ca96eb055f936de` |
| `server.js:974 (reported); server.js:973-978 (current)` | `res_01a19225b5cc140ecc75c4ff7b7e` |
### Work group 9

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:364 (reported); server.js:358 (recoverCorruptRanking)` | `res_01a19225b428cebbe8f9836f3d09` |
| `server.js:400 (reported); server.js:395 (salvageSamples)` | `res_01a19225b430bafb2306875bc15e` |
### Work group 10

| Reported file / endpoint | Result ID |
|---|---|
| `public/app.js:202` | `res_01a19225af34e6b674d7e75515e0` |
| `public/app.js:207` | `res_01a19225af7a4dc4f9ca5c8d698e` |
| `public/app.js:223` | `res_01a19225afad733af19d7663ab9b` |
| `public/app.js:225` | `res_01a19225afb84da7f8f19da1b9fa` |
| `public/app.js:226` | `res_01a19225afc61cc4376cc05454bf` |
| `public/app.js:227` | `res_01a19225afd8c51bf767b7dd23b8` |
| `public/app.js:327` | `res_01a19225b00bdd2f9ad82d273902` |
| `public/app.js:328` | `res_01a19225b01b4cd37ed756b09d7a` |
| `public/app.js:329` | `res_01a19225b02936fc408b1ce123e3` |
| `public/app.js:330` | `res_01a19225b0422d6baa0c4a750177` |
| `public/app.js:331` | `res_01a19225b05f1592b8be7a856360` |
| `public/app.js:515` | `res_01a19225b07ba3fa2770ab617c44` |
| `public/app.js:519` | `res_01a19225b08ccdc70cc6ff1e4def` |
| `public/app.js:548` | `res_01a19225b0decf906e1ae9b4fcdc` |
| `public/app.js:549` | `res_01a19225b0f2822cb703d22a3d14` |
| `public/app.js:550` | `res_01a19225b10f59d7a2bf53bb8371` |
| `public/app.js:551` | `res_01a19225b12d739be66a29513c80` |
| `public/app.js:552` | `res_01a19225b14e383095139f8174f3` |
| `public/app.js:553` | `res_01a19225b165a1d80ab484ab006a` |
| `public/app.js:644` | `res_01a19225b1bbc94f056c29fc50cd` |
| `public/app.js:645` | `res_01a19225b216eb0a1732ed6a3b04` |
| `public/app.js:689` | `res_01a19225b233c8b400df6fe0153f` |
| `public/app.js:690` | `res_01a19225b246cfdecbb7adfd48df` |
| `public/app.js:691` | `res_01a19225b25f1b83fdde5f0d5902` |
| `public/app.js:692` | `res_01a19225b27beb10d9bfaddf61a0` |
| `public/app.js:693` | `res_01a19225b28e38685989d06e6859` |
| `public/app.js:700` | `res_01a19225b29d31fdd9d3532039d2` |
| `public/app.js:703` | `res_01a19225b2ae4bb20c00d8be8fbf` |
| `public/app.js:711` | `res_01a19225b2c85c815f810906bf1a` |
| `public/app.js:712` | `res_01a19225b2e297f643eba00fdedb` |
| `public/app.js:713` | `res_01a19225b301b7b8b0b8809a4741` |
| `public/app.js:715` | `res_01a19225b31006553ce31b971c89` |
| `public/app.js:716` | `res_01a19225b31aa91297456813230e` |
| `public/app.js:720` | `res_01a19225b3225ae518355f73e702` |
| `public/app.js:725` | `res_01a19225b32b112777a13d2d9f4a` |
| `public/app.js:728` | `res_01a19225b334ccd4de92b3d25980` |
| `public/app.js:729` | `res_01a19225b33d7138ca66b0c8e360` |
| `public/app.js:733` | `res_01a19225b3459503182d488d435c` |
| `public/app.js:740` | `res_01a19225b35b1a752bc2f94d831f` |
| `public/globe.js:193` | `res_01a19225b37fe2ddc7d6362550ae` |
| `public/globe.js:194` | `res_01a19225b3871cdd538d501c9cc0` |
| `public/globe.js:195` | `res_01a19225b390e05db19ef4da63f5` |
| `public/globe.js:206` | `res_01a19225b3a962edf3081a6fca02` |
| `public/globe.js:207` | `res_01a19225b3b231f2b6adb2dffb91` |
| `public/overview.js:101` | `res_01a19225b3e53d4d9d90ad63027d` |
| `public/overview.js:108` | `res_01a19225b4047adfa3a1b4cd5c72` |
| `public/overview.js:73` | `res_01a19225b3cda5c3dc02977b011d` |
| `server.js:543 (reported); server.js:544 (og:title)` | `res_01a19225b442951f9a7e9fb5a98a` |
| `server.js:544 (reported); server.js:545 (og:description)` | `res_01a19225b44c04a694e5768c84fe` |
| `server.js:545 (reported); server.js:546 (og:url)` | `res_01a19225b45e36854aaa08304fa5` |
| `server.js:546 (reported); server.js:547 (og:image)` | `res_01a19225b477fd7b275b93d58200` |
| `server.js:548 (reported); server.js:549 (twitter:title)` | `res_01a19225b48fb8fef46a010b5003` |
| `server.js:549 (reported); server.js:550 (twitter:description)` | `res_01a19225b4aec1976a99c65cce0d` |
| `server.js:550 (reported); server.js:551 (twitter:image)` | `res_01a19225b4cbba58f43daabaac46` |
| `server.js:591 (reported); server.js:592 (current)` | `res_01a19225b4e62639565f60155f88` |
| `server.js:594 (reported); server.js:595 (current)` | `res_01a19225b504982bc44518c37618` |
| `server.js:628 (reported); server.js:629 (current)` | `res_01a19225b5553281188202adf926` |
| `server.js:634 (reported); server.js:635 (current)` | `res_01a19225b56e375b1e48c849cfd9` |
### Work group 11

| Reported file / endpoint | Result ID |
|---|---|
| `agent/package.json:8` | `res_01a19225ae8984b6ac077cd9d521` |
| `package.json:12` | `res_01a19225aeb74bf408f5bfbaaa20` |
| `package.json:13` | `res_01a19225aec937fd439ea70d73b1` |
| `package.json:14` | `res_01a19225aedc95eafc777ff6b97e` |
| `package.json:15` | `res_01a19225aeef3a603a3b18fc51b3` |
### Work group 12

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:812 (reported); server.js:792; docker-compose.yml:ports` | `res_01a19225b5ac37e36e60119d7f8b` |
### Work group 13

| Reported file / endpoint | Result ID |
|---|---|
| `GET /` | `res_01a1912195689db5767d1118f015` |
### Work group 14

| Reported file / endpoint | Result ID |
|---|---|
| `/ WebSocket upgrade; server.js:801-824` | `res_01a192533a3f46e715b60f1a4819` |
### Work group 15

| Reported file / endpoint | Result ID |
|---|---|
| `/ WebSocket mtr/sov messages; server.js:892-909,1141,1479` | `res_01a192533a6685b36032941f6753` |
### Work group 16

| Reported file / endpoint | Result ID |
|---|---|
| `GET /` | `res_01a190c8e16a2235d98ab6320b5a` |
### Work group 17

| Reported file / endpoint | Result ID |
|---|---|
| `GET /` | `res_01a191219575cd2353766ca28269` |
### Work group 18

| Reported file / endpoint | Result ID |
|---|---|
| `GET /` | `res_01a19121957d275b2132e01d7544` |
### Work group 19

| Reported file / endpoint | Result ID |
|---|---|
| `Dockerfile:4` | `res_01a19225add5f29bc03c70028b98` |
| `agent/Dockerfile:3` | `res_01a19225ae44fcc6cb5ece55da2e` |
### Work group 20

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:493 (reported); app/routes and browser WS handlers` | `res_01a19225b43934a5442940bda904` |
### Work group 21

| Reported file / endpoint | Result ID |
|---|---|
| `server.js:23` | `res_01a19225b416f840f42716d1c19f` |
| `server.js:24` | `res_01a19225b41fd205659fe53321c8` |

## Per-result outcome table

“Fixed” means reviewable local implementation and passing checks; it does not mean Provenby has resolved the result. Complete source-to-sink reasons and exact control evidence for every ID are in `security-findings.json`.

| Result ID | Disposition | Files changed | Verification performed | Remaining action / callback |
|---|---|---|---|---|
| res_01a19225aeff0e1bd5d34145c0e8 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af53f6c6aaed34557fe6 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af8c3c38c371b604a955 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225afef28c0732ede2d4bcb | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0995e317d70adfe53e6 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0b853a9d865d51d5ca5 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b17c46d00075392cedcf | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b1db9581863b5c682a7d | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b34c3e41fa02f666aaaf | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b36347272d7a7976af18 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3718d2344769e94dfba | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b398b71090bea0c1163c | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3d5d855a9a8dec91b0f | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3f2d85aca68918ef242 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3bb1dca43bab85e21af | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af15d3cd571870e6da88 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af68f13fb287e927d65a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af9e96142cfa78b6fe5f | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225affe05657335f3805898 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0a92cfc90ecfba3854f | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0c9a620b41c2e26ed5a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b19df2655f375db69042 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b1f554e1e2114085db32 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b353107f059d40e304d6 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b36adbd2e8f99387da55 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b378334bf7abd89306cb | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3a0305e12682525e634 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3dd28c33c60d38e9c96 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3fbec9754c23170db4a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3c59a82d9263bc177db | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b58ea4c1c5cb0fe3614b | not reproducible | tests/backend-history.test.js | tests/backend-history.test.js: oversized/normal bucket query and four prototype-key negative controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a192533a1ae12f6b3e5e66df04 | fixed | server.js, history-reader.js, history-worker.js, tests/backend-history.test.js, tests/helpers/backend-fixture.cjs | Prior synchronous event-loop blocking reproduced and fixed; refreshed review adds true HTTP active/queued deadline and concurrent API availability coverage.7 history tests pass; both test deadline responses settled in55.6ms at a50ms fixture setting. Production setting remains5000ms. | Code remains undeployed. After authorized deployment run staged heavy-history and oversized-bucket/duplicate-target cases while polling /api/probes and observing WS feed; verify bounded503/200 and no unrelated stall, then request Provenby retest. No callback action for fixed findings. not sent: implemented fix requires separate Provenby retest |
| res_01a19225adfd10fe96105831fefe | not reproducible | None | Inspected same-layer apt install/list cleanup and official Debian docker-clean policy; network-isolated pingscope:v64 fixture cache archives and .bin files were removed by its configured APT post-update hook; valid empty-cache control passed. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225ae66ffac2bafafc1a141 | not reproducible | None | Inspected same-layer apt install/list cleanup and official Debian docker-clean policy; network-isolated pingscope:v64 fixture cache archives and .bin files were removed by its configured APT post-update hook; valid empty-cache control passed. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225ae207bc3f70c7f694c0a | not reproducible | None | Parsed actual RUN: only logical OR (\|\|), no pipe operator; ran actual shell command with local setcap fixture success/failure; both intentionally exit 0. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b51ec1ea82b531fbad37 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: SVG previews hostile/control case passes. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b5395b6343a88b6aef8f | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: SVG previews hostile/control case passes. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b40d9ca96eb055f936de | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b5cc140ecc75c4ff7b7e | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: host validator hostile and safe controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b428cebbe8f9836f3d09 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: real SQLite backup recovery and path-shaped API negative control pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b430bafb2306875bc15e | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: real SQLite backup recovery and path-shaped API negative control pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af34e6b674d7e75515e0 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225af7a4dc4f9ca5c8d698e | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225afad733af19d7663ab9b | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225afb84da7f8f19da1b9fa | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225afc61cc4376cc05454bf | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225afd8c51bf767b7dd23b8 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b00bdd2f9ad82d273902 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b01b4cd37ed756b09d7a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b02936fc408b1ce123e3 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0422d6baa0c4a750177 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b05f1592b8be7a856360 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b07ba3fa2770ab617c44 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b08ccdc70cc6ff1e4def | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0decf906e1ae9b4fcdc | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b0f2822cb703d22a3d14 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b10f59d7a2bf53bb8371 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b12d739be66a29513c80 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b14e383095139f8174f3 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b165a1d80ab484ab006a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b1bbc94f056c29fc50cd | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b216eb0a1732ed6a3b04 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b233c8b400df6fe0153f | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b246cfdecbb7adfd48df | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b25f1b83fdde5f0d5902 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b27beb10d9bfaddf61a0 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b28e38685989d06e6859 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b29d31fdd9d3532039d2 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b2ae4bb20c00d8be8fbf | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b2c85c815f810906bf1a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b2e297f643eba00fdedb | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b301b7b8b0b8809a4741 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b31006553ce31b971c89 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b31aa91297456813230e | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3225ae518355f73e702 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b32b112777a13d2d9f4a | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b334ccd4de92b3d25980 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b33d7138ca66b0c8e360 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3459503182d488d435c | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b35b1a752bc2f94d831f | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b37fe2ddc7d6362550ae | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3871cdd538d501c9cc0 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b390e05db19ef4da63f5 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3a962edf3081a6fca02 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3b231f2b6adb2dffb91 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3e53d4d9d90ad63027d | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b4047adfa3a1b4cd5c72 | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b3cda5c3dc02977b011d | not reproducible | tests/frontend-security.test.js | Source-to-sink review and local safe/hostile renderer controls; node --test tests/frontend-security.test.js: 10/10 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b442951f9a7e9fb5a98a | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b44c04a694e5768c84fe | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b45e36854aaa08304fa5 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b477fd7b275b93d58200 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b48fb8fef46a010b5003 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b4aec1976a99c65cce0d | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b4cbba58f43daabaac46 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: metadata helper and real HTTP hostile Host/query controls pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b4e62639565f60155f88 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: SVG preview hostile/control assertions pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b504982bc44518c37618 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: SVG preview hostile/control assertions pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b5553281188202adf926 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: sovereignty SVG hostile/control assertions and local PNG endpoint pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b56e375b1e48c849cfd9 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: sovereignty SVG hostile/control assertions and local PNG endpoint pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225ae8984b6ac077cd9d521 | not reproducible | agent/Dockerfile, tests/build-security.test.js | Tracked/in-sync lock + integrity verified; mismatched-lock negative control rejected. node --test tests/build-security.test.js: before 2 pass/2 fail, after 4 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225aeb74bf408f5bfbaaa20 | not reproducible | Dockerfile, tests/build-security.test.js | Tracked/in-sync lock + integrity verified; mismatched-lock negative control rejected. node --test tests/build-security.test.js: before 2 pass/2 fail, after 4 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225aec937fd439ea70d73b1 | not reproducible | Dockerfile, tests/build-security.test.js | Tracked/in-sync lock + integrity verified; mismatched-lock negative control rejected. node --test tests/build-security.test.js: before 2 pass/2 fail, after 4 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225aedc95eafc777ff6b97e | not reproducible | Dockerfile, tests/build-security.test.js | Tracked/in-sync lock + integrity verified; mismatched-lock negative control rejected. node --test tests/build-security.test.js: before 2 pass/2 fail, after 4 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225aeef3a603a3b18fc51b3 | not reproducible | Dockerfile, tests/build-security.test.js | Tracked/in-sync lock + integrity verified; mismatched-lock negative control rejected. node --test tests/build-security.test.js: before 2 pass/2 fail, after 4 pass. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b5ac37e36e60119d7f8b | not reproducible | None | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a1912195689db5767d1118f015 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a192533a3f46e715b60f1a4819 | fixed | server.js, tests/backend-websocket.test.js | Both WS tests pass: foreign/null/malformed/cross-scheme403; same-origin HTTP, proxied HTTPS, canonical default-port and originless native101; invalid agent token rejected; distinct-IP quota control preserved. | After authorized deployment confirm edge Host/X-Forwarded-Proto behavior, same-origin browser WSS101, explicit hostile/null Origin403 and native/agent compatibility; request Provenby retest. No callback action for fixed findings. not sent: implemented fix requires separate Provenby retest |
| res_01a192533a6685b36032941f6753 | not reproducible | tests/backend-websocket.test.js | tests/backend-websocket.test.js: distinct-IP allowed and same-IP denied controls pass; two mock mtr spawns only. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a190c8e16a2235d98ab6320b5a | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a191219575cd2353766ca28269 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a19121957d275b2132e01d7544 | not reproducible | tests/security-headers.test.js | Current source review, local Bootload gateway-template inspection, and passing real loopback header/nonce controls; owner-confirmed Bootload scope. No production probe. | Excluded from Pingscope remediation at owner request; any live edge validation/remediation belongs to Bootload. No application change needed. ignore callback HTTP 200: Bootload scope exclusion requested by owner |
| res_01a19225add5f29bc03c70028b98 | fixed | Dockerfile | Reverified current FROM pin against official OCI index; docker build --check passed without warnings in both contexts; build regression suite 4/4 passed on Node22.23.4. | Include modified Dockerfile and required new runtime modules in the reviewed change, rebuild images, then run the appropriate Provenby code retest; no fixed/resolved callback exists. not sent: implemented fix requires separate Provenby retest |
| res_01a19225ae44fcc6cb5ece55da2e | fixed | agent/Dockerfile | Reverified current FROM pin against official OCI index; docker build --check passed without warnings in both contexts; build regression suite 4/4 passed on Node22.23.4. | Include modified Dockerfile and required new runtime modules in the reviewed change, rebuild images, then run the appropriate Provenby code retest; no fixed/resolved callback exists. not sent: implemented fix requires separate Provenby retest |
| res_01a19225b43934a5442940bda904 | not reproducible | tests/backend-controls.test.js | tests/backend-controls.test.js: anonymous/cookie controls plus source audit of every HTTP handler and WS agent authentication. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b416f840f42716d1c19f | not reproducible | tests/backend-websocket.test.js | tests/backend-websocket.test.js: imported spawn exercised by two successful local mock traces; source declaration/use inspection. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
| res_01a19225b41fd205659fe53321c8 | not reproducible | tests/backend-websocket.test.js | tests/backend-websocket.test.js: both real ws server constructors/endpoints exercised; source declaration/use inspection. | Ignore callback succeeded; retain control tests and re-evaluate if the input/control path changes. ignore callback HTTP 200 |
