import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Push-based hint channel over Herdr's socket API.
 *
 * Herdr 0.8.x exposes `events.wait` only for agent-status matches, but
 * `events.subscribe` streams pane lifecycle events as newline-delimited JSON. That is
 * exactly what cbds needs to notice a dead worker pane without polling.
 *
 * Everything here is ADVISORY. A pane event can make a wait fail fast; it can never
 * settle a task. If the socket is missing, closed, or unsupported, cbds degrades to
 * liveness polling and stays correct.
 */
export class HerdrEvents extends EventEmitter {
  constructor({ socketPath = process.env.HERDR_SOCKET_PATH } = {}) {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.buffer = '';
    this.closed = false;
  }

  get available() { return Boolean(this.socketPath); }

  connect(subscriptions = [{ type: 'pane.closed' }, { type: 'pane.exited' }]) {
    if (!this.available) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };

      try {
        this.socket = net.createConnection(this.socketPath);
      } catch {
        return done(false);
      }

      this.socket.setEncoding('utf8');
      this.socket.on('connect', () => {
        this.socket.write(`${JSON.stringify({
          id: `cbds:${process.pid}`,
          method: 'events.subscribe',
          params: { subscriptions },
        })}\n`);
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.result?.type === 'subscription_started') { done(true); continue; }
          if (msg.error) { done(false); continue; }
          if (msg.event) this.emit('event', { event: msg.event, data: msg.data ?? {} });
        }
      });

      this.socket.on('error', () => { done(false); this.emit('closed'); });
      this.socket.on('close', () => { done(false); this.emit('closed'); });

      // Never let a hint channel stall a real operation.
      setTimeout(() => done(false), 3000).unref?.();
    });
  }

  /** Resolve when the given pane closes or exits. Returns null on timeout/unavailability. */
  onPaneDeath(paneId, handler) {
    const listener = ({ event, data }) => {
      if (data?.pane_id !== paneId) return;
      if (event === 'pane_closed' || event === 'pane_exited') handler({ event, data });
    };
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.destroy(); } catch { /* already gone */ }
  }
}

/** One-shot helper: does this pane die within `timeoutMs`? Advisory only. */
export const watchPaneDeath = async (paneId, onDeath) => {
  const events = new HerdrEvents();
  const ok = await events.connect([
    { type: 'pane.closed' }, { type: 'pane.exited' },
  ]);
  if (!ok) { events.close(); return { supported: false, stop: () => {} }; }
  const off = events.onPaneDeath(paneId, onDeath);
  return { supported: true, stop: () => { off(); events.close(); } };
};
