import assert from 'node:assert/strict';
import test from 'node:test';
import { OutboxWorker } from '../src/worker.mjs';

test('worker coalesces concurrent ticks, bounds each batch and stops further work', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; }); let calls = 0; let stopped = false;
  const worker = new OutboxWorker({
    drainOne: async () => { calls++; if (calls === 1) await pending; return { outcome: 'fixture' }; },
    stop: () => { stopped = true; resolve(); },
  }, { batchSize: 2 });
  const first = worker.tick(); const second = worker.tick(); resolve();
  assert.equal((await first).length, 2); assert.equal((await second).length, 2); assert.equal(calls, 2);
  await worker.stop(); assert.equal(stopped, true); assert.deepEqual(await worker.tick(), []); assert.equal(calls, 2);
});

test('worker starts only explicitly and cancels its scheduler on stop', async () => {
  const scheduled = []; const canceled = [];
  const worker = new OutboxWorker({ drainOne: async () => undefined, stop: () => {} }, {
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: id => canceled.push(id),
  });
  assert.equal(scheduled.length, 0);
  worker.start(); worker.start(); assert.equal(scheduled.length, 1);
  await scheduled[0].fn(); assert.equal(scheduled.length, 2);
  await worker.stop(); assert.deepEqual(canceled, [2]);
  await scheduled[1].fn(); assert.equal(scheduled.length, 2);
});
