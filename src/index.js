/**
 * <focus-timer> custom element entry point. Assembles core/ports/view/input/runtime.
 * This file is intentionally a thin skeleton until all modules land — see
 * CLAUDE.md "파일 소유권" for which files are owned by which workstream.
 */
class FocusTimer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // TODO(integration): assemble core/ports/view/input/runtime once modules land.
  }

  disconnectedCallback() {
    // TODO(integration): teardown.
  }

  static define(tag = 'focus-timer') {
    if (!customElements.get(tag)) {
      customElements.define(tag, FocusTimer);
    }
  }
}

FocusTimer.define();

window.FocusTimer = FocusTimer;

export { FocusTimer };
