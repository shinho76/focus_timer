/**
 * view/dial.js — SVG 다이얼 렌더러.
 *
 * 규칙: view/ 는 시간을 모른다. 이미 계산된 값(분, progress 0..1)만 받아 그린다.
 * innerHTML 금지 — 모든 노드는 createElementNS 로 만든다.
 *
 * 지오메트리 (spec §3.1)
 *   0 = 12시 방향, 시계방향 진행, 60분 = 360°, 1분 = 6°.
 *
 * 갱신 전략 (spec 수용기준 36 — 1초 갱신 시 리페인트/레이아웃 스래시 0)
 *   최초 1회만 전체 트리를 만들고(build), 이후 호출은 존재하는 노드의
 *   attribute/class 만 패치한다. 트리를 다시 만들지 않는다.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 뷰박스 한 변 (정사각) */
export const VIEWBOX = 200;
/** 다이얼 중심 좌표 */
export const CENTER = VIEWBOX / 2;
/** 1분당 각도 (spec §3.1: 60분 = 360°) */
export const DEG_PER_MIN = 6;
/** 세그먼트 개수 (1분 = 1조각) */
export const SEGMENT_COUNT = 60;
/** 조각 사이 간격 = 조각 각도의 18% (spec §3.1: 15~20%) */
export const SEGMENT_GAP_RATIO = 0.18;

/** 게이지 바깥 반지름 */
export const GAUGE_OUTER_R = 74;
/** 세그먼트 게이지 안쪽 반지름 */
export const GAUGE_INNER_R = 52;
/** 중앙 허브(리드아웃 배경) 반지름 */
export const HUB_R = 50;
/** 눈금/라벨 반지름 */
export const TICK_OUTER_R = 84;
export const TICK_MINOR_INNER_R = 80;
export const TICK_MAJOR_INNER_R = 77;
export const LABEL_R = 92;
/** 다이얼 배경 원 반지름 */
export const FACE_R = 98;

/** 경로 좌표 반올림 자릿수 (테스트 결정성 확보용) */
const PRECISION = 3;

const registry = new WeakMap();

const numberFormatCache = new Map();

/**
 * @param {string|undefined} locale
 * @param {Intl.NumberFormatOptions} [options]
 * @returns {Intl.NumberFormat}
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

/** @param {number} n */
function round(n) {
  const f = 10 ** PRECISION;
  // -0 방지
  return Math.round(n * f) / f + 0;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 0 = 12시, 시계방향 극좌표 → 데카르트 좌표.
 * @param {number} r 반지름
 * @param {number} deg 각도(도), 0 = 12시 방향
 * @param {number} [cx]
 * @param {number} [cy]
 * @returns {{x:number,y:number}}
 */
export function polarPoint(r, deg, cx = CENTER, cy = CENTER) {
  const rad = (deg * Math.PI) / 180;
  return { x: round(cx + r * Math.sin(rad)), y: round(cy - r * Math.cos(rad)) };
}

/**
 * 게이지가 채워야 할 각도. spec 수용기준 6:
 * 잔량 각도 = remaining/total × 설정각 = progress × (설정 분 × 6°).
 * @param {number} minutes 설정된(총) 분
 * @param {number} progress 남은 비율 0..1 (idle 이면 1)
 * @returns {number} 도(deg), 0..360
 */
export function gaugeSweepDeg(minutes, progress) {
  const m = clamp(Number(minutes) || 0, 0, SEGMENT_COUNT);
  const p = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  return clamp(m * DEG_PER_MIN * p, 0, 360);
}

/**
 * 점등할 세그먼트 수 = 남은 분 수 (올림 — 1분이 다 소모되어야 꺼진다).
 * @param {number} minutes
 * @param {number} progress
 * @returns {number}
 */
export function litSegmentCount(minutes, progress) {
  const m = clamp(Math.round(Number(minutes) || 0), 0, SEGMENT_COUNT);
  const p = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  return clamp(Math.ceil(m * p - 1e-9), 0, m) + 0; // -0 정규화
}

/**
 * 연속 부채꼴(pie) 경로. 0에서 시계방향으로 sweep 만큼.
 * @param {number} sweepDeg
 * @param {number} [r]
 * @returns {string} path d
 */
export function sectorPath(sweepDeg, r = GAUGE_OUTER_R) {
  const sweep = clamp(sweepDeg, 0, 360);
  if (sweep <= 0) return `M ${CENTER} ${CENTER} Z`;
  if (sweep >= 360) {
    const top = polarPoint(r, 0);
    const bottom = polarPoint(r, 180);
    return (
      `M ${top.x} ${top.y} ` +
      `A ${r} ${r} 0 1 1 ${bottom.x} ${bottom.y} ` +
      `A ${r} ${r} 0 1 1 ${top.x} ${top.y} Z`
    );
  }
  const start = polarPoint(r, 0);
  const end = polarPoint(r, sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  return (
    `M ${CENTER} ${CENTER} ` +
    `L ${start.x} ${start.y} ` +
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`
  );
}

/**
 * index 번째(0-based) 1분 세그먼트의 고리형 조각 경로.
 * @param {number} index 0..SEGMENT_COUNT-1
 * @param {number} [ro]
 * @param {number} [ri]
 * @returns {string} path d
 */
export function segmentPath(index, ro = GAUGE_OUTER_R, ri = GAUGE_INNER_R) {
  const gap = DEG_PER_MIN * SEGMENT_GAP_RATIO;
  const a0 = index * DEG_PER_MIN + gap / 2;
  const a1 = (index + 1) * DEG_PER_MIN - gap / 2;
  const o0 = polarPoint(ro, a0);
  const o1 = polarPoint(ro, a1);
  const i1 = polarPoint(ri, a1);
  const i0 = polarPoint(ri, a0);
  return (
    `M ${o0.x} ${o0.y} ` +
    `A ${ro} ${ro} 0 0 1 ${o1.x} ${o1.y} ` +
    `L ${i1.x} ${i1.y} ` +
    `A ${ri} ${ri} 0 0 0 ${i0.x} ${i0.y} Z`
  );
}

/**
 * @param {string} name
 * @param {Record<string, string|number>} [attrs]
 * @returns {SVGElement}
 */
function svg(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
}

/**
 * 값이 실제로 바뀔 때만 setAttribute (불필요한 무효화 방지).
 * @param {Element} el
 * @param {string} name
 * @param {string} value
 */
function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * CSP-safe 스타일 주입 (spec §9.2).
 * `style-src 'self'` 사이트에서 JS 로 만든 <style> 이 죽는 문제 때문에
 * adoptedStyleSheets 를 먼저 시도하고, 실패하면 <style> 로 폴백한다.
 *
 * ⚠ 이 헬퍼의 소유자는 view/dial.js 다. index.js(통합)가 shadow root 당 한 번만 호출한다.
 *
 * @param {ShadowRoot|Document} root
 * @param {string} cssText  esbuild `.css` → `text` 로더로 불러온 styles.css 원문
 * @returns {'adopted'|'style-element'} 어떤 경로를 썼는지
 */
export function applyStyles(root, cssText) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    root.adoptedStyleSheets = [...(root.adoptedStyleSheets || []), sheet];
    return 'adopted';
  } catch {
    const s = document.createElement('style');
    s.textContent = cssText;
    root.append(s);
    return 'style-element';
  }
}

/**
 * 눈금 + 라벨 (정적 — 한 번만 만든다).
 * @param {SVGElement} parent
 * @param {string|undefined} locale
 */
function buildTicks(parent, locale) {
  const ticks = svg('g', { class: 'ft-ticks' });
  for (let m = 0; m < SEGMENT_COUNT; m += 1) {
    const deg = m * DEG_PER_MIN;
    const major = m % 5 === 0;
    const inner = major ? TICK_MAJOR_INNER_R : TICK_MINOR_INNER_R;
    const p1 = polarPoint(inner, deg);
    const p2 = polarPoint(TICK_OUTER_R, deg);
    ticks.append(
      svg('line', {
        class: major ? 'ft-tick ft-tick--major' : 'ft-tick',
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
      }),
    );
  }
  parent.append(ticks);

  const nf = getNumberFormat(locale);
  const labels = svg('g', { class: 'ft-labels' });
  for (let m = 0; m < SEGMENT_COUNT; m += 5) {
    const p = polarPoint(LABEL_R, m * DEG_PER_MIN);
    const t = svg('text', {
      class: 'ft-label',
      x: p.x,
      y: p.y,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
    });
    t.textContent = nf.format(m);
    labels.append(t);
  }
  parent.append(labels);
}

/**
 * 게이지 레이어 생성. gauge 스타일이 바뀌면 이 레이어만 교체한다.
 * @param {'sector'|'segments'} gauge
 * @returns {{layer: SVGElement, sector: SVGElement|null, segments: SVGElement[]}}
 */
function buildGaugeLayer(gauge) {
  const layer = svg('g', { class: `ft-gauge-layer ft-gauge-layer--${gauge}` });
  if (gauge === 'segments') {
    const segments = [];
    for (let i = 0; i < SEGMENT_COUNT; i += 1) {
      const seg = svg('path', {
        class: 'ft-segment',
        d: segmentPath(i),
        'data-minute': String(i + 1),
      });
      layer.append(seg);
      segments.push(seg);
    }
    return { layer, sector: null, segments };
  }
  const sector = svg('path', { class: 'ft-sector', d: sectorPath(0), part: 'gauge' });
  layer.append(sector);
  return { layer, sector, segments: [] };
}

/**
 * @param {Element|ShadowRoot} container
 * @param {{gauge:'sector'|'segments', locale?:string}} opts
 */
function build(container, opts) {
  const root = document.createElement('div');
  root.className = 'ft-dial';
  root.setAttribute('part', 'dial');
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-valuemin', '1');

  const s = svg('svg', {
    class: 'ft-dial-svg',
    viewBox: `0 0 ${VIEWBOX} ${VIEWBOX}`,
    focusable: 'false',
    'aria-hidden': 'true',
  });

  s.append(svg('circle', { class: 'ft-face', cx: CENTER, cy: CENTER, r: FACE_R }));
  s.append(
    svg('circle', {
      class: 'ft-track',
      cx: CENTER,
      cy: CENTER,
      r: (GAUGE_OUTER_R + GAUGE_INNER_R) / 2,
      'stroke-width': GAUGE_OUTER_R - GAUGE_INNER_R,
      fill: 'none',
    }),
  );

  const g = buildGaugeLayer(opts.gauge);
  s.append(g.layer);

  s.append(svg('circle', { class: 'ft-hub', cx: CENTER, cy: CENTER, r: HUB_R }));
  buildTicks(s, opts.locale);

  root.append(s);
  container.append(root);

  return {
    root,
    svg: s,
    gauge: opts.gauge,
    layer: g.layer,
    sector: g.sector,
    segments: g.segments,
    lit: -1,
    locale: opts.locale,
  };
}

/**
 * 다이얼을 만들거나 갱신한다.
 *
 * @param {Element|ShadowRoot} container 이미 존재하는 DOM 컨테이너(shadow root 가능)
 * @param {object} data
 * @param {number} data.minutes      설정된(총) 분 = slider 값. aria-valuenow
 * @param {number} [data.maxMinutes] aria-valuemax (기본 60)
 * @param {number} [data.progress]   남은 비율 0..1 (기본 1 = idle 상태)
 * @param {'sector'|'segments'} [data.gauge] 게이지 스타일 (기본 'sector')
 * @param {boolean} [data.disabled]  running/paused/ringing 이면 true (spec §3.4)
 * @param {string} [data.unit]       aria-valuetext 단위 (기본 '분')
 * @param {string} [data.label]      aria-label
 * @param {string} [data.locale]     Intl 로케일
 * @returns {HTMLElement} role="slider" 인 다이얼 루트 (input/pointer.js 에 넘길 요소)
 */
export function renderDial(container, data) {
  const {
    minutes = 0,
    maxMinutes = 60,
    progress = 1,
    gauge = 'sector',
    disabled = false,
    unit = '분',
    label,
    locale,
  } = data || {};
  const style = gauge === 'segments' ? 'segments' : 'sector';

  let refs = registry.get(container);
  if (!refs || !container.contains(refs.root)) {
    refs = build(container, { gauge: style, locale });
    registry.set(container, refs);
  }

  // 게이지 스타일이 바뀐 경우에만 해당 레이어를 교체 (전체 재생성 아님)
  if (refs.gauge !== style) {
    const next = buildGaugeLayer(style);
    refs.layer.replaceWith(next.layer);
    refs.layer = next.layer;
    refs.sector = next.sector;
    refs.segments = next.segments;
    refs.gauge = style;
    refs.lit = -1;
  }

  const shownMinutes = clamp(Math.round(Number(minutes) || 0), 0, maxMinutes);

  // --- 게이지 (attribute 만 갱신) ---
  if (style === 'sector') {
    setAttr(refs.sector, 'd', sectorPath(gaugeSweepDeg(minutes, progress)));
  } else {
    const lit = litSegmentCount(minutes, progress);
    if (lit !== refs.lit) {
      const from = refs.lit < 0 ? 0 : Math.min(refs.lit, lit);
      const to = refs.lit < 0 ? SEGMENT_COUNT : Math.max(refs.lit, lit);
      for (let i = from; i < to; i += 1) {
        refs.segments[i].classList.toggle('is-on', i < lit);
      }
      refs.lit = lit;
    }
  }

  // --- ARIA (spec §3.4, §8) ---
  const r = refs.root;
  setAttr(r, 'aria-valuemax', String(maxMinutes));
  setAttr(r, 'aria-valuenow', String(shownMinutes));
  setAttr(r, 'aria-valuetext', `${getNumberFormat(locale).format(shownMinutes)}${unit}`);
  if (label != null) setAttr(r, 'aria-label', String(label));
  setAttr(r, 'aria-disabled', disabled ? 'true' : 'false');
  setAttr(r, 'tabindex', disabled ? '-1' : '0');
  setAttr(r, 'data-gauge', style);

  return r;
}

/**
 * 테스트/재초기화용 — 컨테이너에 캐시된 참조를 버린다.
 * @param {Element|ShadowRoot} container
 */
export function resetDial(container) {
  registry.delete(container);
}
