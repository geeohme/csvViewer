import { setOverlay } from './ui.js';

// ---------- worker RPC ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let seq = 0;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.progress) return setOverlay(m.progress.stage, m.progress.frac);
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error));
  else p.resolve(m.result);
};
export const call = (cmd, args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });

