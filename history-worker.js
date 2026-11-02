'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const bucketStmt = db.prepare(`
  SELECT
    CAST((t - $from) / $bucket AS INTEGER) AS b,
    MIN(min) AS min, MAX(max) AS max, AVG(median) AS median,
    AVG(p25) AS p25, AVG(p75) AS p75, AVG(loss) AS loss,
    SUM(sent) AS sent, SUM(recv) AS recv, COUNT(*) AS n
  FROM samples
  WHERE target_id = $tid AND t >= $from AND t < $to
  GROUP BY b ORDER BY b
`);

process.on('message', ({ ids, from, to, bucket }) => {
  try {
    const targets = {};
    for (const tid of ids) {
      targets[tid] = bucketStmt.all({ tid, from, to, bucket }).map((r) => ({
        targetId: tid, t: from + (r.b + 0.5) * bucket,
        min: r.min, max: r.max, median: r.median, p25: r.p25, p75: r.p75,
        loss: r.loss, sent: r.sent, recv: r.recv, n: r.n, samples: [],
      }));
    }
    if (process.connected) process.send({ targets });
  } catch {
    if (process.connected) process.send({ error: true });
  }
});

// An idle child must not survive a disconnected parent. Normal shutdown and
// request deadlines also send SIGKILL so native calls cannot delay retirement.
process.on('disconnect', () => { db.close(); process.exit(0); });
