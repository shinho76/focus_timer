/**
 * view/readout.js — 다이얼 중앙 숫자 리드아웃.
 *
 * 규칙: view/ 는 시간을 모른다. 표시할 값과 형식 플래그만 받는다.
 * `showSeconds` 의 임계값(≤60초) 판단은 호출자(index.js) 몫이다 — 여기선 시키는 대로 그린다.
 *
 * 접근성 (spec §3.4, §8)
 *   중앙 숫자 = role="timer" + aria-live="off" (매초 낭독 금지).
 *   ⚠ role="slider" 는 바깥 트랙(view/dial.js)에만. 같은 요소에 두 role 금지.
 *
 * 갱신 전략: 최초 1회만 노드를 만들고, 이후에는 textContent/hidden 만 바꾼다.
 */

const registry = new WeakMap();

const numberFormatCache = new Map();

/**
 * @param {string|undefined} locale
 * @param {Intl.NumberFormatOptions} [options]
 */
function getNumberFormat(locale, options) {
  const key = `${locale || ''}|${JSON.stringify(options || {})}`;
  let nf = numberFormatCache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, { useGrouping: false, ...options });
    numberFormatCache.set(key, nf);
  }
  return nf;
}

/**
 * 표시 문자열을 만든다. 기본은 분만, showSeconds 면 `M:SS`.
 * @param {number} minutes
 * @param {number} seconds
 * @param {boolean} showSeconds
 * @param {string} [locale]
 * @returns {string}
 */
export function formatValue(minutes, seconds, showSeconds, locale) {
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  if (!showSeconds) return getNumberFormat(locale).format(m);
  const s = Math.max(0, Math.min(59, Math.trunc(Number(seconds) || 0)));
  const ss = getNumberFormat(locale, { minimumIntegerDigits: 2 }).format(s);
  return `${getNumberFormat(locale).format(m)}:${ss}`;
}

/**
 * @param {Element|ShadowRoot} container
 */
function build(container) {
  const root = document.createElement('div');
  root.className = 'ft-readout';
  root.setAttribute('part', 'readout');
  root.setAttribute('role', 'timer');
  root.setAttribute('aria-live', 'off');

  const value = document.createElement('span');
  value.className = 'ft-readout-value';

  const unit = document.createElement('span');
  unit.className = 'ft-readout-unit';

  root.append(value, unit);
  container.append(root);

  return { root, value, unit, lastValue: null, lastUnit: null, lastHidden: null };
}

/**
 * 중앙 리드아웃을 만들거나 갱신한다.
 *
 * @param {Element|ShadowRoot} container
 * @param {object} data
 * @param {number} data.minutes        표시할 분
 * @param {number} [data.seconds]      표시할 초 (showSeconds 일 때만 사용)
 * @param {boolean} [data.showSeconds] true 면 `M:SS`, false 면 분 + 단위 라벨
 * @param {string} [data.unit]         단위 라벨 (기본 '분')
 * @param {string} [data.locale]       Intl 로케일
 * @returns {HTMLElement} role="timer" 인 리드아웃 루트
 */
export function renderReadout(container, data) {
  const {
    minutes = 0,
    seconds = 0,
    showSeconds = false,
    unit = '분',
    locale,
  } = data || {};

  let refs = registry.get(container);
  if (!refs || !container.contains(refs.root)) {
    refs = build(container);
    registry.set(container, refs);
  }

  const text = formatValue(minutes, seconds, showSeconds, locale);
  if (text !== refs.lastValue) {
    refs.value.textContent = text;
    refs.lastValue = text;
  }

  // M:SS 로 바뀌면 단위 라벨은 숨긴다 (spec §3.1 중앙: 큰 숫자 + 단위 라벨)
  const hideUnit = Boolean(showSeconds);
  if (hideUnit !== refs.lastHidden) {
    refs.unit.hidden = hideUnit;
    refs.lastHidden = hideUnit;
  }
  if (!hideUnit && unit !== refs.lastUnit) {
    refs.unit.textContent = unit;
    refs.lastUnit = unit;
  }

  const mode = showSeconds ? 'ms' : 'minutes';
  if (refs.root.getAttribute('data-format') !== mode) {
    refs.root.setAttribute('data-format', mode);
  }

  return refs.root;
}

/**
 * 테스트/재초기화용.
 * @param {Element|ShadowRoot} container
 */
export function resetReadout(container) {
  registry.delete(container);
}
