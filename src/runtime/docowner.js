/**
 * runtime/docowner.js — global `document.title` ownership (spec §7.3).
 *
 * Two `<focus-timer>` elements on one page must not fight over the document
 * title. A module-scope, first-come-first-served registry decides who owns it.
 *
 *   const DocOwner = { title: null };
 *   claim(inst)   -> false if someone else already owns it
 *   release(inst) -> restores the snapshot and clears ownership
 *
 * Design decisions (documented for the integration layer):
 * - The original title is snapshotted at claim time and restored with `===`
 *   fidelity on `releaseTitle()` **and** on `pagehide` (criterion 23). The
 *   `pagehide` listener is registered **inside this module** on
 *   `doc.defaultView` at claim time, so callers do not have to wire it through
 *   lifecycle.js; a missing `destroy()` can no longer poison the host title.
 * - SPA baseline updates: `setTitle()` remembers the exact string it wrote. If
 *   the document title changes to something we did not write, that value is
 *   adopted as the new baseline automatically. `rebaseTitle(inst, doc, base?)`
 *   lets the host signal the change explicitly (e.g. from a router hook).
 */

/** @type {{ title: string|null, original: string|null, doc: any, win: any, lastWritten: string|null, onPagehide: any }} */
const DocOwner = {
  title: null, // instanceId of the current owner
  original: null, // exact snapshot taken at claim time
  doc: null,
  win: null,
  lastWritten: null,
  onPagehide: null,
};

function unwire() {
  if (DocOwner.win && DocOwner.onPagehide && typeof DocOwner.win.removeEventListener === 'function') {
    DocOwner.win.removeEventListener('pagehide', DocOwner.onPagehide);
  }
  DocOwner.onPagehide = null;
  DocOwner.win = null;
}

function restoreTitle() {
  if (DocOwner.doc && typeof DocOwner.original === 'string') {
    DocOwner.doc.title = DocOwner.original;
    DocOwner.lastWritten = DocOwner.original;
  }
}

/**
 * Claim ownership of `document.title`.
 *
 * @param {string} instanceId
 * @param {{ title: string, defaultView?: any }} doc
 * @returns {boolean} false when another instance already owns the title.
 */
export function claimTitle(instanceId, doc) {
  if (!instanceId || !doc) return false;
  if (DocOwner.title && DocOwner.title !== instanceId) return false;
  if (DocOwner.title === instanceId) return true; // idempotent re-claim

  DocOwner.title = instanceId;
  DocOwner.doc = doc;
  DocOwner.original = doc.title;
  DocOwner.lastWritten = doc.title;

  const win = doc.defaultView || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (win && typeof win.addEventListener === 'function') {
    // Restore on pagehide but KEEP ownership: with bfcache the instance is
    // still alive and the next setTitle() re-applies the countdown.
    DocOwner.onPagehide = () => restoreTitle();
    DocOwner.win = win;
    win.addEventListener('pagehide', DocOwner.onPagehide);
  }
  return true;
}

/**
 * Release ownership and restore the snapshotted title exactly.
 *
 * @param {string} instanceId
 * @param {{ title: string }} [doc] ignored when it is not the owning document.
 * @returns {boolean} true when this instance owned the title and released it.
 */
export function releaseTitle(instanceId, doc) {
  if (!instanceId || DocOwner.title !== instanceId) return false;
  if (doc && DocOwner.doc && doc !== DocOwner.doc) return false;
  restoreTitle();
  unwire();
  DocOwner.title = null;
  DocOwner.original = null;
  DocOwner.doc = null;
  DocOwner.lastWritten = null;
  return true;
}

/**
 * Write the document title. Only the owner may write.
 * Also performs the automatic SPA baseline update: anything we did not write
 * ourselves becomes the new baseline before we overwrite it.
 *
 * @param {string} instanceId
 * @param {string} text
 * @returns {boolean} true when the write happened.
 */
export function setTitle(instanceId, text) {
  if (DocOwner.title !== instanceId || !DocOwner.doc) return false;
  const current = DocOwner.doc.title;
  if (current !== DocOwner.lastWritten) DocOwner.original = current; // SPA routed
  DocOwner.doc.title = text;
  DocOwner.lastWritten = text;
  return true;
}

/**
 * Explicit baseline update for SPA routing ("the host title changed").
 *
 * @param {string} instanceId
 * @param {{ title: string }} [doc]
 * @param {string} [base] new baseline; defaults to the current document title.
 * @returns {boolean}
 */
export function rebaseTitle(instanceId, doc, base) {
  if (DocOwner.title !== instanceId || !DocOwner.doc) return false;
  DocOwner.original = typeof base === 'string' ? base : DocOwner.doc.title;
  return true;
}

/** @returns {string|null} current owner instanceId (debug/tests). */
export function getTitleOwner() {
  return DocOwner.title;
}

/** @returns {string|null} the exact snapshot that will be restored. */
export function getOriginalTitle() {
  return DocOwner.original;
}

/**
 * Test-only escape hatch: drop ownership without touching the document.
 * Never call this from product code — it exists so unit tests can reset the
 * module-scope singleton between cases.
 */
export function __resetDocOwner() {
  unwire();
  DocOwner.title = null;
  DocOwner.original = null;
  DocOwner.doc = null;
  DocOwner.lastWritten = null;
}
