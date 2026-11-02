'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');

// SQLite aggregation is synchronous. Keep it off the HTTP/WS event loop, and
// admit only a bounded amount of work even when many clients request history.
// A separate process lets SIGKILL interrupt native SQLite at the deadline.
class HistoryReader {
  constructor(dbPath, { timeoutMs = 5000, maxPending = 8 } = {}) {
    this.dbPath = dbPath;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.workerClosed = null;
    this.stopping = null;
    this.retiringWorker = null;
    this.closed = false;
    this.onParentExit = () => {
      try { (this.worker || this.retiringWorker)?.kill('SIGKILL'); } catch { /* already gone */ }
    };
    process.once('exit', this.onParentExit);
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
        worker = fork(path.join(__dirname, 'history-worker.js'), [this.dbPath], {
          execArgv: ['--experimental-sqlite'],
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
      } catch {
        for (const task of this.queue.splice(0)) {
          clearTimeout(task.timer);
          task.reject(new Error('history worker unavailable'));
        }
        return;
      }
      this.worker = worker;
      // Register before any error/exit handlers: failed spawns can emit close
      // without exit, and normal exit can precede stdio/IPC closure.
      this.workerClosed = new Promise((resolve) => worker.once('close', resolve));
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
      worker.on('close', () => this.restart(worker, new Error('history worker closed')));
    }
    const task = this.active = this.queue.shift();
    const worker = this.worker;
    try { worker.send(task.params, (error) => { if (error) this.restart(worker, new Error('history query failed')); }); }
    catch { this.restart(worker, new Error('history query failed')); }
  }

  restart(worker, error) {
    if (!worker || this.worker !== worker) return;
    const closed = this.workerClosed;
    this.worker = null;
    this.workerClosed = null;
    this.retiringWorker = worker;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(error);
      this.active = null;
    }
    // Wait for actual process closure before replacement: at most one SQLite
    // reader, even while a timed-out native statement is being killed.
    this.stopping = closed.finally(() => {
      this.retiringWorker = null;
      this.stopping = null;
      this.runNext();
    });
    if (worker.exitCode === null && worker.signalCode === null) {
      try { worker.kill('SIGKILL'); } catch { /* close still releases the slot */ }
    }
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
    process.removeListener('exit', this.onParentExit);
  }
}
module.exports = { HistoryReader };
