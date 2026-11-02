'use strict';
const { performance } = require('node:perf_hooks');

// Charge the maximum number of returned samples, so a single selected graph
// remains inexpensive while repeated whole-catalog downloads are throttled.
class HistoryBudget {
  constructor({ capacity = 100000, refillMs = 60000, maxClients = 5000, now = () => performance.now() } = {}) {
    Object.assign(this, { capacity, refillMs, maxClients, now });
    this.clients = new Map();
    this.nextCleanup = 0;
  }

  take(ip, cost) {
    const now = this.now();
    let client = this.clients.get(ip);
    if (!client) {
      if (this.clients.size >= this.maxClients && now >= this.nextCleanup) {
        // Fully refilled inactive entries can be removed without resetting an
        // active client's budget. Bound cleanup work even under new-IP floods.
        for (const [key, value] of this.clients) {
          if (now - value.at >= this.refillMs) this.clients.delete(key);
        }
        this.nextCleanup = now + 1000;
      }
      if (this.clients.size >= this.maxClients) return Math.ceil(this.refillMs / 1000);
      client = { tokens: this.capacity, at: now };
      this.clients.set(ip, client);
    }
    client.tokens = Math.min(this.capacity, client.tokens + Math.max(0, now - client.at) * this.capacity / this.refillMs);
    client.at = now;
    if (cost > this.capacity) return Math.ceil(this.refillMs / 1000);
    if (client.tokens < cost) return Math.ceil((cost - client.tokens) * this.refillMs / this.capacity / 1000);
    client.tokens -= cost;
    return 0;
  }
}
module.exports = { HistoryBudget };
