export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const fns = this.listeners.get(event);
    if (!fns) return;
    const at = fns.indexOf(fn);
    if (at >= 0) fns.splice(at);
  }

  emit(event, payload) {
    const fns = this.listeners.get(event);
    if (!fns) return 0;
    for (const fn of [...fns]) fn(payload);
    return fns.length;
  }

  clear(event) {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }
}
