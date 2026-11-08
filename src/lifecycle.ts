import { ServiceError } from './contracts.js';

/** Instance-local state; initialization and draining are irreversible transitions. */
export class Lifecycle {
  private phase: 'initializing' | 'ready' | 'draining' | 'stopped' = 'initializing';
  private active = 0;
  private idleWaiters = new Set<() => void>();
  get ready() { return this.phase === 'ready'; }
  markReady() {
    if (this.phase !== 'initializing') return false;
    this.phase = 'ready'; return true;
  }
  drain() {
    if (this.phase === 'draining' || this.phase === 'stopped') return false;
    this.phase = 'draining'; return true;
  }
  stop() { this.phase = 'stopped'; }
  assertReady() {
    if (!this.ready) throw new ServiceError(this.phase === 'initializing' ? 'NOT_READY' : 'DRAINING', 'Service is not accepting new work', 503);
  }
  acquire() {
    this.assertReady(); this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }
  whenIdle(): Promise<void> {
    return this.active === 0 ? Promise.resolve() : new Promise(resolve => this.idleWaiters.add(resolve));
  }
}
