'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// SQLite aggregation is synchronous. Keep it off the HTTP/WS event loop, and
// admit only a bounded amount of work even when many clients request history.
class HistoryReader {
  constructor(dbPath, { timeoutMs = 5000, maxPending = 8 } = {}) {
    this.dbPath = dbPath;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.stopping = null;
    this.closed = false;
  }

  read(params) {
    if (this.closed) return Promise.reject(new Error('history reader closed'));
    if (this.queue.length + Number(!!this.active) >= this.maxPending) {
      return Promise.reject(new Error('history reader busy'));
    }
    return new Promise((resolve, reject) => {
      const task = { params, resolve, reject };
      // The deadline includes time waiting in the queue, so overloaded callers
      // receive a bounded response even if SQLite has not finished terminating.
      task.timer = setTimeout(() => {
        const index = this.queue.indexOf(task);
        if (index >= 0) {
          this.queue.splice(index, 1);
          task.reject(new Error('history query timed out'));
        } else if (this.active === task) {
          this.restart(this.worker, new Error('history query timed out'));
        }
      }, this.timeoutMs);
      this.queue.push(task);
      this.runNext();
    });
  }

  runNext() {
    if (this.closed || this.active || this.stopping || !this.queue.length) return;
    if (!this.worker) {
      let worker;
      try {
        worker = new Worker(path.join(__dirname, 'history-worker.js'), { workerData: { dbPath: this.dbPath } });
      } catch {
        for (const task of this.queue.splice(0)) {
          clearTimeout(task.timer);
          task.reject(new Error('history worker unavailable'));
        }
        return;
      }
      this.worker = worker;
      worker.on('message', (message) => {
        if (this.worker !== worker || !this.active) return;
        const task = this.active;
        this.active = null;
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error('history query failed'));
        else task.resolve(message.targets);
        this.runNext();
      });
      worker.on('error', () => this.restart(worker, new Error('history worker failed')));
      worker.on('exit', () => this.restart(worker, new Error('history worker exited')));
    }
    const task = this.active = this.queue.shift();
    try { this.worker.postMessage(task.params); }
    catch { this.restart(this.worker, new Error('history query failed')); }
  }

  restart(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = null;
    }
    // Await termination before admitting another query: at most one worker.
    this.stopping = worker.terminate().finally(() => {
      this.stopping = null;
      this.runNext();
    });
  }

  async close() {
    this.closed = true;
    const error = new Error('history reader closed');
    for (const task of this.queue.splice(0)) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    if (this.worker) this.restart(this.worker, error);
    await this.stopping;
  }
}
module.exports = { HistoryReader };
