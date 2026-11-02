'use strict';
// Local HTTP liveness check: do not run a measurement or an expensive history query.
const http = require('node:http');
const request = http.get({
  hostname: '127.0.0.1', port: process.env.PORT || 3000, path: '/api/probes', timeout: 4000,
}, (response) => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('health check timed out')));
request.on('error', () => { process.exitCode = 1; });
