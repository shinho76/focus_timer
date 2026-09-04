import { describe, it, expect, vi } from 'vitest';
import { attachLifecycle } from '../../src/runtime/lifecycle.js';
import { createFakeClock } from '../fakes/fakeClock.js';

/** Minimal EventTarget-like fake: no jsdom, no real window/document. */
function createFakeTarget(extra = {}) {
  const map = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    dispatch(type, props = {}) {
      const event = { type, timeStamp: 1234, ...props };
      for (const fn of [...(map.get(type) || [])]) fn(event);
      return event;
    },
    listenerCount(type) {
      return map.get(type)?.size ?? 0;
    },
    totalListeners() {
      let n = 0;
      for (const set of map.values()) n += set.size;
      return n;
    },
  };
}

function setup(handlers = {}) {
  const win = createFakeTarget();
  const doc = createFakeTarget({ visibilityState: 'visible' });
  const spies = {
    onHide: vi.fn(),
    onShow: vi.fn(),
    onFreeze: vi.fn(),
    onResume: vi.fn(),
    onRestore: vi.fn(),
    onBlur: vi.fn(),
    onFocus: vi.fn(),
  };
  const merged = { ...spies, ...handlers };
  const detach = attachLifecycle(win, doc, merged);
  return { win, doc, spies: merged, detach };
}

describe('attachLifecycle — visibility', () => {
  it('hidden -> onHide, visible -> onShow', () => {
    const { doc, spies } = setup();
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(spies.onHide).toHaveBeenCalledTimes(1);
    expect(spies.onHide.mock.calls[0][0].reason).toBe('hidden');
    expect(spies.onShow).not.toHaveBeenCalled();

    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    expect(spies.onShow).toHaveBeenCalledTimes(1);
    expect(spies.onShow.mock.calls[0][0].reason).toBe('visible');
  });

  it('does not fire onShow when it was never hidden', () => {
    const { doc, spies } = setup();
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    expect(spies.onShow).not.toHaveBeenCalled();
  });

  it('fires the onHide callback synchronously so the caller can markGap()', () => {
    const order = [];
    const markGap = () => order.push('markGap');
    const { doc } = setup({ onHide: () => markGap() });
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    order.push('after-dispatch');
    expect(order).toEqual(['markGap', 'after-dispatch']);
  });

  it('includes clock timestamps when a clock port is supplied', () => {
    const clock = createFakeClock();
    const win = createFakeTarget();
    const doc = createFakeTarget({ visibilityState: 'visible' });
    const onHide = vi.fn();
    attachLifecycle(win, doc, { onHide, clock });
    clock.advance(5000);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    const p = onHide.mock.calls[0][0];
    expect(p.wallAt).toBe(clock.wall());
    expect(p.monoAt).toBe(clock.mono());
  });
});

describe('attachLifecycle — pagehide / pageshow (bfcache)', () => {
  it('pagehide carries event.persisted so the caller can distinguish bfcache', () => {
    const { win, spies } = setup();
    win.dispatch('pagehide', { persisted: true });
    expect(spies.onHide).toHaveBeenCalledTimes(1);
    expect(spies.onHide.mock.calls[0][0].persisted).toBe(true);
    expect(spies.onHide.mock.calls[0][0].reason).toBe('pagehide-persisted');

    spies.onHide.mockClear();
    win.dispatch('pagehide', { persisted: false });
    expect(spies.onHide.mock.calls[0][0].persisted).toBe(false);
    expect(spies.onHide.mock.calls[0][0].reason).toBe('pagehide');
  });

  it('pageshow(persisted) triggers its OWN reconcile, distinct from the storage-restore path', () => {
    const { win, spies } = setup();
    win.dispatch('pagehide', { persisted: true });
    win.dispatch('pageshow', { persisted: true });
    expect(spies.onRestore).toHaveBeenCalledTimes(1);
    const p = spies.onRestore.mock.calls[0][0];
    expect(p.type).toBe('pageshow');
    expect(p.bfcache).toBe(true);
    expect(p.reason).toBe('bfcache');
    // Not routed through onShow: the bfcache settle must not be confused with a
    // plain visibility change, and must not double-fire.
    expect(spies.onShow).not.toHaveBeenCalled();
  });

  it('pageshow without a dedicated onRestore falls back to onResume', () => {
    const win = createFakeTarget();
    const doc = createFakeTarget({ visibilityState: 'visible' });
    const onResume = vi.fn();
    attachLifecycle(win, doc, { onResume });
    win.dispatch('pageshow', { persisted: true });
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume.mock.calls[0][0].bfcache).toBe(true);
  });

  it('pageshow(persisted:false) — a fresh load — fires nothing (storage path owns it)', () => {
    const { win, spies } = setup();
    win.dispatch('pageshow', { persisted: false });
    expect(spies.onRestore).not.toHaveBeenCalled();
    expect(spies.onResume).not.toHaveBeenCalled();
    expect(spies.onShow).not.toHaveBeenCalled();
  });
});

describe('attachLifecycle — freeze / resume / blur / focus', () => {
  it('wires freeze and resume', () => {
    const { doc, spies } = setup();
    doc.dispatch('freeze');
    expect(spies.onFreeze).toHaveBeenCalledTimes(1);
    expect(spies.onFreeze.mock.calls[0][0].type).toBe('freeze');
    doc.dispatch('resume');
    expect(spies.onResume).toHaveBeenCalledTimes(1);
    expect(spies.onResume.mock.calls[0][0].reason).toBe('resume-event');
  });

  it('blur/focus fire their own callbacks and are never mapped onto hide/show', () => {
    const { win, spies } = setup();
    win.dispatch('blur');
    win.dispatch('focus');
    expect(spies.onBlur).toHaveBeenCalledTimes(1);
    expect(spies.onFocus).toHaveBeenCalledTimes(1);
    expect(spies.onHide).not.toHaveBeenCalled();
    expect(spies.onShow).not.toHaveBeenCalled();
  });

  it('missing optional callbacks do not throw', () => {
    const win = createFakeTarget();
    const doc = createFakeTarget({ visibilityState: 'visible' });
    attachLifecycle(win, doc, {});
    expect(() => {
      doc.dispatch('visibilitychange');
      win.dispatch('blur');
      win.dispatch('pageshow', { persisted: true });
      doc.dispatch('freeze');
    }).not.toThrow();
  });
});

describe('attachLifecycle — detach', () => {
  it('removes every listener and is idempotent (criterion 23: 0 stray callbacks)', () => {
    const { win, doc, spies, detach } = setup();
    expect(win.totalListeners() + doc.totalListeners()).toBe(7);
    detach();
    detach.detach(); // both call styles are supported
    detach();
    expect(win.totalListeners() + doc.totalListeners()).toBe(0);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    win.dispatch('pageshow', { persisted: true });
    expect(spies.onHide).not.toHaveBeenCalled();
    expect(spies.onRestore).not.toHaveBeenCalled();
  });
});
