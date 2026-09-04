/**
 * runtime/lifecycle.js — full Page Lifecycle coverage (spec §4.3).
 *
 * `visibilitychange` alone is not enough. This module wires the whole surface:
 *   visibilitychange(hidden)  -> onHide   ({ type:'visibilitychange', reason:'hidden' })
 *   visibilitychange(visible) -> onShow   ({ type:'visibilitychange', reason:'visible' })
 *   pagehide                  -> onHide   ({ type:'pagehide', persisted:<bool> })
 *   pageshow(persisted:true)  -> onRestore if given, else onResume ({ reason:'bfcache' })
 *   pageshow(persisted:false) -> nothing (a fresh load goes through the localStorage path)
 *   freeze                    -> onFreeze ({ type:'freeze' })
 *   resume                    -> onResume ({ type:'resume', reason:'resume-event' })
 *   blur / focus              -> onBlur / onFocus (optional, never mapped onto hide/show)
 *
 * Nothing is swallowed: every callback fires synchronously inside the event
 * handler, so the caller can do `onHide: () => clock.markGap()` and still be
 * inside the hide moment.
 *
 * DOM/browser APIs are parameterised (`win`, `doc`) so tests can pass plain
 * EventTarget-like fakes. Per CLAUDE.md this file never calls `Date.now()` or
 * `performance.now()`; if the caller wants timestamps on the payload it passes
 * an optional `clock` port (`{ wall(), mono() }`) in the options bag.
 *
 * @typedef {Object} LifecyclePayload
 * @property {string} type       DOM event type that produced the callback.
 * @property {string} reason     Finer-grained cause ('hidden'|'visible'|'bfcache'|...).
 * @property {boolean|undefined} persisted  `event.persisted` for pagehide/pageshow.
 * @property {boolean} bfcache   True only for a bfcache restore (`pageshow.persisted`).
 * @property {number|undefined} timeStamp   `event.timeStamp` when the event exposes one.
 * @property {number|undefined} wallAt      `clock.wall()` when a clock port was supplied.
 * @property {number|undefined} monoAt      `clock.mono()` when a clock port was supplied.
 * @property {Event} event       The raw event object.
 */

/** Callbacks required by the module contract plus optional extras. */
/**
 * @typedef {Object} LifecycleHandlers
 * @property {(p: LifecyclePayload) => void} [onHide]
 * @property {(p: LifecyclePayload) => void} [onShow]
 * @property {(p: LifecyclePayload) => void} [onFreeze]
 * @property {(p: LifecyclePayload) => void} [onResume]
 * @property {(p: LifecyclePayload) => void} [onRestore] bfcache-specific reconcile hook.
 * @property {(p: LifecyclePayload) => void} [onBlur]
 * @property {(p: LifecyclePayload) => void} [onFocus]
 * @property {{ wall: () => number, mono: () => number }} [clock]
 */

/**
 * Attach page-lifecycle listeners.
 *
 * @param {EventTarget & { addEventListener: Function }} win  window-like object.
 * @param {EventTarget & { visibilityState?: string }} doc     document-like object.
 * @param {LifecycleHandlers} handlers
 * @returns {(() => void) & { detach: () => void, get isHidden: boolean }}
 *   A `detach` function (idempotent). It also carries a `.detach` alias so both
 *   `off()` and `off.detach()` work for whoever wires this up.
 */
export function attachLifecycle(win, doc, handlers = {}) {
  const {
    onHide,
    onShow,
    onFreeze,
    onResume,
    onRestore,
    onBlur,
    onFocus,
    clock,
  } = handlers;

  /** @type {Array<[any, string, Function]>} */
  const bound = [];
  let detached = false;
  // Tracks our own notion of visibility so onShow never fires twice for one
  // hide (e.g. pagehide followed by pageshow, or focus after visibilitychange).
  let hidden = false;

  /**
   * @param {Event} event
   * @param {string} reason
   * @returns {LifecyclePayload}
   */
  function payload(event, reason) {
    const persisted = event && typeof event.persisted === 'boolean' ? event.persisted : undefined;
    return {
      type: (event && event.type) || reason,
      reason,
      persisted,
      bfcache: event && event.type === 'pageshow' ? persisted === true : false,
      timeStamp: event && typeof event.timeStamp === 'number' ? event.timeStamp : undefined,
      wallAt: clock && typeof clock.wall === 'function' ? clock.wall() : undefined,
      monoAt: clock && typeof clock.mono === 'function' ? clock.mono() : undefined,
      event,
    };
  }

  function call(fn, event, reason) {
    if (typeof fn !== 'function') return;
    fn(payload(event, reason));
  }

  function on(target, type, fn) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    bound.push([target, type, fn]);
  }

  const handleVisibility = (event) => {
    const state = doc && doc.visibilityState;
    if (state === 'hidden') {
      hidden = true;
      call(onHide, event, 'hidden');
    } else {
      // Treat anything not explicitly 'hidden' as visible (fakes may omit it).
      if (!hidden) return;
      hidden = false;
      call(onShow, event, 'visible');
    }
  };

  const handlePagehide = (event) => {
    hidden = true;
    // `persisted === true` means the page is bfcache-eligible: JS state stays
    // alive, so the caller should mark a gap rather than tear everything down.
    call(onHide, event, event && event.persisted ? 'pagehide-persisted' : 'pagehide');
  };

  const handlePageshow = (event) => {
    if (!(event && event.persisted)) {
      // Normal load: JS state was rebuilt and the storage-restore path already
      // reconciles. Firing here would double-settle, so we stay quiet.
      return;
    }
    hidden = false;
    // bfcache restore: memory state survived, so the localStorage restore path
    // is NOT taken — but real time still elapsed. This is its own settle call.
    const p = payload(event, 'bfcache');
    if (typeof onRestore === 'function') onRestore(p);
    else if (typeof onResume === 'function') onResume(p);
  };

  const handleFreeze = (event) => {
    hidden = true;
    call(onFreeze, event, 'freeze');
  };

  const handleResume = (event) => {
    hidden = false;
    call(onResume, event, 'resume-event');
  };

  // blur/focus are deliberately NOT mapped onto onHide/onShow: a blurred tab is
  // usually still visible and still running, so marking a clock gap there would
  // be wrong. They are exposed only through their own optional callbacks.
  const handleBlur = (event) => call(onBlur, event, 'blur');
  const handleFocus = (event) => call(onFocus, event, 'focus');

  on(doc, 'visibilitychange', handleVisibility);
  on(win, 'pagehide', handlePagehide);
  on(win, 'pageshow', handlePageshow);
  on(doc, 'freeze', handleFreeze);
  on(doc, 'resume', handleResume);
  on(win, 'blur', handleBlur);
  on(win, 'focus', handleFocus);

  const detach = () => {
    if (detached) return;
    detached = true;
    for (const [target, type, fn] of bound) {
      if (target && typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, fn);
      }
    }
    bound.length = 0;
  };

  detach.detach = detach;
  Object.defineProperty(detach, 'isHidden', { get: () => hidden });
  return detach;
}
