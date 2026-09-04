/**
 * input/keyboard.js — 다이얼 키보드 조작 + 드래그와 동등 지위의 병렬 입력 수단 배선.
 *
 * 명세 대응: spec-v4 §3.3(병렬 입력), §8(Space 전역 단축키 금지), §3.4(running 중 거부)
 * 수용 기준: 7, 30
 *
 * ⚠ 리스너는 오직 dialEl(또는 호출자가 넘긴 개별 컨트롤 요소)에만 붙는다.
 *   document/window 레벨에는 아무것도 붙이지 않는다 → Space 가 페이지 스크롤을 뺏지 않는다.
 */

/** @typedef {(deltaMinutes: number) => void} DeltaCallback */
/** @typedef {(minutes: number) => void} SetCallback */

/**
 * @typedef {object} KeyboardOptions
 * @property {DeltaCallback} [onDelta]    상대 변경(±1 / ±5).
 * @property {SetCallback}   [onSet]      절대 지정(Home/End).
 * @property {() => void}    [onActivate] Space/Enter — 위젯 내부 포커스일 때만 호출(시작/일시정지 토글용).
 * @property {number}        [min=1]      Home 값.
 * @property {number}        [max=60]     End 값.
 * @property {() => boolean} [disabled]   true 면 모든 키를 no-op.
 */

/**
 * @typedef {object} KeyboardHandle
 * @property {() => void} detach
 * @property {(v: boolean|null) => void} setDisabled
 */

/** 프리셋 버튼 값 (spec §2.3 / §3.3). */
export const PRESET_MINUTES = Object.freeze([5, 10, 25, 50]);

/** ± 버튼 스텝 (spec §2.3 / §3.3). */
export const DELTA_STEPS = Object.freeze([-5, -1, 1, 5]);

/**
 * 분 값을 [min,max] 정수로 정규화한다. 숫자가 아니면 null.
 * @param {unknown} value
 * @param {number} [min=1]
 * @param {number} [max=60]
 * @returns {number|null}
 */
export function clampMinutes(value, min = 1, max = 60) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/**
 * 다이얼(포커스 보유 시)에 키보드 조작을 배선한다.
 * ←/→ ±1분, ↑/↓ ±5분, PageUp/PageDown ±5분, Home/End 최소/최대, Space/Enter 활성화.
 * @param {HTMLElement|SVGElement} dialEl
 * @param {KeyboardOptions} [options]
 * @returns {KeyboardHandle}
 */
export function attachKeyboard(dialEl, options = {}) {
  const { onDelta, onSet, onActivate, min = 1, max = 60, disabled } = options;
  if (!dialEl) throw new TypeError('attachKeyboard: dialEl is required');

  let disabledFlag = /** @type {boolean|null} */ (null);

  function isDisabled() {
    if (disabledFlag === true) return true;
    if (typeof disabled === 'function' && disabled()) return true;
    return dialEl.getAttribute && dialEl.getAttribute('aria-disabled') === 'true';
  }

  /**
   * 위젯 내부 포커스 확인. 리스너가 dialEl 에 있으므로 대부분 자동 충족이지만,
   * 명세 §8("기본 off, 위젯 내부 포커스일 때만 Space/Enter 동작")을 코드로도 못박는다.
   */
  function isFocusedWithin() {
    const doc = dialEl.ownerDocument;
    if (!doc) return true;
    const active = doc.activeElement;
    if (!active) return false;
    if (active === dialEl) return true;
    // shadow DOM: 호스트가 activeElement 로 보고될 수 있다.
    const root = dialEl.getRootNode && dialEl.getRootNode();
    if (root && root.host && root.host === active) {
      return root.activeElement === dialEl || (dialEl.contains && dialEl.contains(root.activeElement));
    }
    return !!(dialEl.contains && dialEl.contains(active));
  }

  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!isFocusedWithin()) return;
    if (isDisabled()) return; // spec §3.4: running/paused/ringing 에서는 tabindex="-1" 이지만 코드에서도 막는다

    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        if (onDelta) onDelta(1);
        break;
      case 'ArrowLeft':
        if (onDelta) onDelta(-1);
        break;
      case 'ArrowUp':
        if (onDelta) onDelta(5);
        break;
      case 'ArrowDown':
        if (onDelta) onDelta(-5);
        break;
      case 'PageUp':
        if (onDelta) onDelta(5);
        break;
      case 'PageDown':
        if (onDelta) onDelta(-5);
        break;
      case 'Home':
        if (onSet) onSet(min);
        break;
      case 'End':
        if (onSet) onSet(max);
        break;
      case ' ':
      case 'Spacebar':
      case 'Enter':
        if (onActivate) onActivate();
        break;
      default:
        handled = false;
    }

    // Space 의 페이지 스크롤 기본동작은 '다이얼에 포커스가 있을 때만' 막는다.
    if (handled && typeof e.preventDefault === 'function') e.preventDefault();
  }

  dialEl.addEventListener('keydown', onKeyDown);

  return {
    detach() {
      dialEl.removeEventListener('keydown', onKeyDown);
    },
    setDisabled(v) {
      disabledFlag = v === null || v === undefined ? null : !!v;
    },
  };
}

/**
 * 프리셋 버튼 하나를 배선한다 (5/10/25/50). DOM 생성은 view/ 담당, 여기는 배선만.
 * @param {HTMLElement} buttonEl
 * @param {number} minutes
 * @param {SetCallback} onSet
 * @returns {() => void} detach
 */
export function attachPreset(buttonEl, minutes, onSet) {
  const handler = () => { if (onSet) onSet(clampMinutes(minutes)); };
  buttonEl.addEventListener('click', handler);
  return () => buttonEl.removeEventListener('click', handler);
}

/**
 * ±1 / ±5 버튼 하나를 배선한다.
 * @param {HTMLElement} buttonEl
 * @param {number} delta
 * @param {DeltaCallback} onDelta
 * @returns {() => void} detach
 */
export function attachDelta(buttonEl, delta, onDelta) {
  const handler = () => { if (onDelta) onDelta(delta); };
  buttonEl.addEventListener('click', handler);
  return () => buttonEl.removeEventListener('click', handler);
}

/**
 * `<input type="number" min="1" max="60">` 을 배선한다.
 * 빈 값/비수치는 무시하고, 확정(change) 시 클램프된 값을 입력창에도 되돌려 쓴다.
 * @param {HTMLInputElement} inputEl
 * @param {SetCallback} onSet
 * @param {{min?: number, max?: number}} [opts]
 * @returns {() => void} detach
 */
export function attachNumberInput(inputEl, onSet, opts = {}) {
  const min = opts.min ?? 1;
  const max = opts.max ?? 60;
  const onInput = () => {
    const v = clampMinutes(inputEl.value, min, max);
    if (v !== null && String(inputEl.value).trim() !== '' && onSet) onSet(v);
  };
  const onChange = () => {
    const v = clampMinutes(inputEl.value, min, max);
    if (v === null) return;
    inputEl.value = String(v);
    if (onSet) onSet(v);
  };
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('change', onChange);
  return () => {
    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('change', onChange);
  };
}
