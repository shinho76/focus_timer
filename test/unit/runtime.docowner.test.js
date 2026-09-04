import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimTitle,
  releaseTitle,
  setTitle,
  rebaseTitle,
  getTitleOwner,
  getOriginalTitle,
  __resetDocOwner,
} from '../../src/runtime/docowner.js';

/** Fake document + its defaultView, so no real DOM/global state is touched. */
function createFakeDoc(title = 'Host Site — Docs') {
  const listeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, props = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...props });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return { title, defaultView: win, win };
}

beforeEach(() => __resetDocOwner());

describe('docowner — first-come-first-served ownership', () => {
  it('second instance is refused until the first releases (criterion 24)', () => {
    const doc = createFakeDoc();
    expect(claimTitle('inst-1', doc)).toBe(true);
    expect(claimTitle('inst-2', doc)).toBe(false);
    expect(getTitleOwner()).toBe('inst-1');

    // The loser cannot write either.
    expect(setTitle('inst-2', '49분')).toBe(false);
    expect(doc.title).toBe('Host Site — Docs');

    expect(releaseTitle('inst-2', doc)).toBe(false); // not the owner
    expect(releaseTitle('inst-1', doc)).toBe(true);
    expect(getTitleOwner()).toBe(null);

    // Now succession works.
    expect(claimTitle('inst-2', doc)).toBe(true);
    expect(getTitleOwner()).toBe('inst-2');
  });

  it('re-claim by the same instance is idempotent and keeps the first snapshot', () => {
    const doc = createFakeDoc('Original');
    claimTitle('inst-1', doc);
    setTitle('inst-1', '50분 — 집중');
    expect(claimTitle('inst-1', doc)).toBe(true);
    expect(getOriginalTitle()).toBe('Original');
  });
});

describe('docowner — exact restore', () => {
  it('releaseTitle restores the snapshot with === equality (criterion 23)', () => {
    const original = 'Host Site — Docs';
    const doc = createFakeDoc(original);
    claimTitle('inst-1', doc);
    setTitle('inst-1', '50분 — 집중');
    setTitle('inst-1', '49분 — 집중');
    expect(doc.title).toBe('49분 — 집중');

    releaseTitle('inst-1', doc);
    expect(doc.title === original).toBe(true);
    expect(doc.win.listenerCount('pagehide')).toBe(0);
  });

  it('pagehide also restores the exact original (no dangling title after navigation)', () => {
    const original = 'Host Site — Docs';
    const doc = createFakeDoc(original);
    claimTitle('inst-1', doc);
    setTitle('inst-1', '12분 — 휴식');
    expect(doc.title).not.toBe(original);

    doc.win.dispatch('pagehide', { persisted: true });
    expect(doc.title === original).toBe(true);
    // Ownership survives a bfcache-eligible hide: the instance is still alive.
    expect(getTitleOwner()).toBe('inst-1');

    // ...and a later write re-applies the countdown.
    setTitle('inst-1', '11분 — 휴식');
    expect(doc.title).toBe('11분 — 휴식');
    releaseTitle('inst-1', doc);
    expect(doc.title === original).toBe(true);
  });

  it('release + pagehide together still land on the exact original', () => {
    const original = 'Original Title';
    const doc = createFakeDoc(original);
    claimTitle('inst-1', doc);
    setTitle('inst-1', '5분');
    releaseTitle('inst-1', doc);
    doc.win.dispatch('pagehide', { persisted: false }); // listener already gone
    expect(doc.title === original).toBe(true);
  });
});

describe('docowner — SPA baseline', () => {
  it('adopts an externally changed title as the new baseline automatically', () => {
    const doc = createFakeDoc('Route A');
    claimTitle('inst-1', doc);
    setTitle('inst-1', '50분 — 집중');

    doc.title = 'Route B'; // SPA router changed it behind our back
    setTitle('inst-1', '49분 — 집중'); // detects the foreign value first

    expect(getOriginalTitle()).toBe('Route B');
    releaseTitle('inst-1', doc);
    expect(doc.title === 'Route B').toBe(true);
  });

  it('rebaseTitle lets the host signal the change explicitly', () => {
    const doc = createFakeDoc('Route A');
    claimTitle('inst-1', doc);
    setTitle('inst-1', '50분');
    expect(rebaseTitle('inst-1', doc, 'Route C')).toBe(true);
    expect(rebaseTitle('other', doc, 'Route D')).toBe(false);
    releaseTitle('inst-1', doc);
    expect(doc.title === 'Route C').toBe(true);
  });
});

describe('docowner — guards', () => {
  it('rejects bogus arguments without throwing', () => {
    expect(claimTitle('', createFakeDoc())).toBe(false);
    expect(claimTitle('inst', null)).toBe(false);
    expect(releaseTitle('inst', createFakeDoc())).toBe(false);
    expect(setTitle('inst', 'x')).toBe(false);
  });

  it('works with a document that exposes no defaultView', () => {
    const doc = { title: 'Bare' };
    expect(claimTitle('inst-1', doc)).toBe(true);
    setTitle('inst-1', 'tick');
    releaseTitle('inst-1', doc);
    expect(doc.title === 'Bare').toBe(true);
  });
});
