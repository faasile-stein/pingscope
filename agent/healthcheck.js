'use strict';
// No inbound listener: the container check reads a volatile registration/pong
// heartbeat. A running process with a dead server connection is not healthy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const healthPath = path.join(os.tmpdir(), 'pingscope-agent-health');

function markHealthy() {
  try { fs.writeFileSync(healthPath, String(Date.now()), { mode: 0o600 }); }
  catch { /* A missing writable tmpdir leaves the container unhealthy. */ }
}
function clearHealth() {
  try { fs.unlinkSync(healthPath); }
  catch { /* Absent marker already means unhealthy. */ }
}
function isHealthy() {
  try {
    const timestamp = Number(fs.readFileSync(healthPath, 'utf8'));
    const age = Date.now() - timestamp;
    return Number.isFinite(timestamp) && age >= 0 && age < 75_000;
  } catch { return false; }
}
module.exports = { markHealthy, clearHealth, isHealthy };
if (require.main === module) process.exitCode = isHealthy() ? 0 : 1;
