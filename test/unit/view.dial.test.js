import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderDial,
  applyStyles,
  polarPoint,
  sectorPath,
  segmentPath,
  gaugeSweepDeg,
  litSegmentCount,
  CENTER,
  GAUGE_OUTER_R,
  GAUGE_INNER_R,
  DEG_PER_MIN,
  SEGMENT_COUNT,
  SEGMENT_GAP_RATIO,
} from '../../src/view/dial.js';

// styles.css 는 esbuild 의 `.css` → `text` 로더로 문자열이 되어 배포된다.
// 테스트에서도 같은 방식(원문 텍스트)으로 읽는다.
const cssText = readFileSync(resolve(process.cwd(), 'src/view/styles.css'), 'utf8');

/** @returns {HTMLDivElement} */
function makeContainer() {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('geometry — 0 = 12시, 시계방향, 6°/분 (spec §3.1)', () => {
  it('0° = 12시 방향(위)', () => {
    expect(polarPoint(50, 0)).toEqual({ x: CENTER, y: CENTER - 50 });
  });

  it('90° = 3시 방향(오른쪽) — 시계방향', () => {
    expect(polarPoint(50, 90)).toEqual({ x: CENTER + 50, y: CENTER });
  });

  it('180° = 6시, 270° = 9시', () => {
    expect(polarPoint(50, 180)).toEqual({ x: CENTER, y: CENTER + 50 });
    expect(polarPoint(50, 270)).toEqual({ x: CENTER - 50, y: CENTER });
  });

  it('15분 = 90°, 30분 = 180°, 60분 = 360°', () => {
    expect(15 * DEG_PER_MIN).toBe(90);
    expect(30 * DEG_PER_MIN).toBe(180);
    expect(60 * DEG_PER_MIN).toBe(360);
  });
});

describe('수용기준 6 — 게이지 잔량 각도 = progress × 설정각 (오차 ≤ 0.5°)', () => {
  const cases = [
    { minutes: 25, progress: 1, expected: 150 },
    { minutes: 25, progress: 0.5, expected: 75 },
    { minutes: 25, progress: 0, expected: 0 },
    { minutes: 50, progress: 1, expected: 300 },
    { minutes: 50, progress: 0.42, expected: 126 },
    { minutes: 60, progress: 1, expected: 360 },
    { minutes: 30, progress: 1, expected: 180 },
    { minutes: 1, progress: 1, expected: 6 },
  ];

  for (const c of cases) {
    it(`${c.minutes}분 × progress ${c.progress} → ${c.expected}°`, () => {
      expect(Math.abs(gaugeSweepDeg(c.minutes, c.progress) - c.expected)).toBeLessThanOrEqual(0.5);
    });
  }

  it('progress 를 생략하면 1(잔량 100%)로 본다', () => {
    expect(gaugeSweepDeg(25, undefined)).toBe(150);
  });

  it('범위를 벗어난 progress/분은 클램프된다 (0/60 경계에서 반대편으로 튀지 않음)', () => {
    expect(gaugeSweepDeg(60, 1.5)).toBe(360);
    expect(gaugeSweepDeg(90, 1)).toBe(360);
    expect(gaugeSweepDeg(25, -0.2)).toBe(0);
    expect(gaugeSweepDeg(-5, 1)).toBe(0);
  });
});

describe('sectorPath — 실제 d 값 검증', () => {
  it('0분: 아무것도 그리지 않는 축퇴 경로', () => {
    expect(sectorPath(0)).toBe('M 100 100 Z');
  });

  it('30분(180°): 중심 → 12시 → 6시 반원, largeArc=0', () => {
    // 12시 (100, 100-74) → 6시 (100, 100+74)
    expect(sectorPath(gaugeSweepDeg(30, 1))).toBe(
      `M 100 100 L 100 ${CENTER - GAUGE_OUTER_R} A 74 74 0 0 1 100 ${CENTER + GAUGE_OUTER_R} Z`,
    );
  });

  it('15분(90°): 끝점이 3시 방향', () => {
    expect(sectorPath(gaugeSweepDeg(15, 1))).toBe(
      `M 100 100 L 100 26 A 74 74 0 0 1 ${CENTER + GAUGE_OUTER_R} 100 Z`,
    );
  });

  it('45분(270°): largeArc=1 로 뒤집힌다', () => {
    const d = sectorPath(gaugeSweepDeg(45, 1));
    expect(d).toBe(`M 100 100 L 100 26 A 74 74 0 1 1 ${CENTER - GAUGE_OUTER_R} 100 Z`);
  });

  it('60분(360°): 두 개의 반원 호로 닫힌 완전한 원', () => {
    expect(sectorPath(360)).toBe('M 100 26 A 74 74 0 1 1 100 174 A 74 74 0 1 1 100 26 Z');
  });

  it('sweep 이 커질수록 끝점 각도가 단조 증가한다 (되감기 방향 확인)', () => {
    // 끝점 x 좌표는 0°→90° 구간에서 단조 증가
    const xs = [10, 20, 40, 60, 80].map((deg) => polarPoint(GAUGE_OUTER_R, deg).x);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});

describe('segmentPath — 60조각, 간격 15~20%', () => {
  it('조각 사이 간격은 조각 각도의 18% (spec 15~20%)', () => {
    expect(SEGMENT_GAP_RATIO).toBeGreaterThanOrEqual(0.15);
    expect(SEGMENT_GAP_RATIO).toBeLessThanOrEqual(0.2);
  });

  it('0번 조각은 0.54°~5.46° 구간의 고리형 wedge', () => {
    const gap = DEG_PER_MIN * SEGMENT_GAP_RATIO; // 1.08
    const a0 = gap / 2; // 0.54
    const a1 = DEG_PER_MIN - gap / 2; // 5.46
    const o0 = polarPoint(GAUGE_OUTER_R, a0);
    const o1 = polarPoint(GAUGE_OUTER_R, a1);
    const i1 = polarPoint(GAUGE_INNER_R, a1);
    const i0 = polarPoint(GAUGE_INNER_R, a0);
    expect(segmentPath(0)).toBe(
      `M ${o0.x} ${o0.y} A 74 74 0 0 1 ${o1.x} ${o1.y} L ${i1.x} ${i1.y} A 52 52 0 0 0 ${i0.x} ${i0.y} Z`,
    );
  });

  it('15번 조각(15~16분)은 3시 방향 근처에 있다', () => {
    const d = segmentPath(15);
    const first = d.match(/^M ([\d.]+) ([\d.]+)/);
    const x = Number(first[1]);
    const y = Number(first[2]);
    expect(x).toBeGreaterThan(CENTER + 70); // 거의 정동쪽
    expect(Math.abs(y - CENTER)).toBeLessThan(2);
  });

  it('모든 조각의 d 는 서로 다르고 60개다', () => {
    const all = new Set();
    for (let i = 0; i < SEGMENT_COUNT; i += 1) all.add(segmentPath(i));
    expect(all.size).toBe(60);
  });
});

describe('litSegmentCount — 남은 분만큼 점등', () => {
  it('progress 1 → 설정 분 전체 점등', () => {
    expect(litSegmentCount(25, 1)).toBe(25);
  });

  it('progress 0 → 전부 소등', () => {
    expect(litSegmentCount(25, 0)).toBe(0);
  });

  it('부분 소모된 분은 아직 켜져 있다 (올림)', () => {
    // 25분 중 절반 = 12.5분 남음 → 13조각
    expect(litSegmentCount(25, 0.5)).toBe(13);
    // 60분 중 1초 남음
    expect(litSegmentCount(60, 1 / 3600)).toBe(1);
  });

  it('설정 분을 넘지 않는다', () => {
    expect(litSegmentCount(10, 1)).toBe(10);
    expect(litSegmentCount(10, 5)).toBe(10);
  });
});

describe('renderDial — DOM 구조', () => {
  it('role="slider" 루트 + svg + 눈금 + 라벨을 만든다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 25, maxMinutes: 60, progress: 1, gauge: 'sector' });

    expect(root.tagName).toBe('DIV');
    expect(root.getAttribute('role')).toBe('slider');
    expect(root.classList.contains('ft-dial')).toBe(true);
    expect(root.getAttribute('part')).toBe('dial');

    const svg = root.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 200');

    // 1분 간격 tick 60개, 5분 간격 라벨 12개
    expect(root.querySelectorAll('.ft-tick').length).toBe(60);
    expect(root.querySelectorAll('.ft-tick--major').length).toBe(12);
    const labels = [...root.querySelectorAll('.ft-label')].map((n) => n.textContent);
    expect(labels).toEqual(['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
  });

  it('모든 노드가 SVG 네임스페이스로 만들어진다 (innerHTML 미사용)', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 10 });
    for (const n of root.querySelectorAll('svg *')) {
      expect(n.namespaceURI).toBe('http://www.w3.org/2000/svg');
    }
  });

  it('sector 가 기본 게이지다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 10 });
    expect(root.getAttribute('data-gauge')).toBe('sector');
    expect(root.querySelector('.ft-sector')).toBeTruthy();
    expect(root.querySelectorAll('.ft-segment').length).toBe(0);
  });

  it('segments 는 60조각을 만들고 남은 분만큼 점등한다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 25, progress: 1, gauge: 'segments' });
    const segs = root.querySelectorAll('.ft-segment');
    expect(segs.length).toBe(60);
    expect(root.querySelectorAll('.ft-segment.is-on').length).toBe(25);
    // 점등은 0번부터 연속
    expect(segs[0].classList.contains('is-on')).toBe(true);
    expect(segs[24].classList.contains('is-on')).toBe(true);
    expect(segs[25].classList.contains('is-on')).toBe(false);
    // d 는 계산값과 일치
    expect(segs[3].getAttribute('d')).toBe(segmentPath(3));
  });
});

describe('renderDial — 게이지 값이 실제로 반영된다', () => {
  it('sector 의 d 가 sectorPath 계산값과 일치한다 (0 / 30 / 60분)', () => {
    const c = makeContainer();
    for (const minutes of [0, 30, 60]) {
      renderDial(c, { minutes, progress: 1, gauge: 'sector' });
      const d = c.querySelector('.ft-sector').getAttribute('d');
      expect(d).toBe(sectorPath(minutes * DEG_PER_MIN));
    }
  });

  it('progress 가 줄면 sector 가 되감긴다 (25분 → 잔량 절반)', () => {
    const c = makeContainer();
    renderDial(c, { minutes: 25, progress: 1, gauge: 'sector' });
    const full = c.querySelector('.ft-sector').getAttribute('d');
    renderDial(c, { minutes: 25, progress: 0.5, gauge: 'sector' });
    const half = c.querySelector('.ft-sector').getAttribute('d');
    expect(full).toBe(sectorPath(150));
    expect(half).toBe(sectorPath(75));
    expect(half).not.toBe(full);
  });

  it('segments 점등 수가 잔량에 따라 단조 감소한다', () => {
    const c = makeContainer();
    const counts = [];
    for (const p of [1, 0.8, 0.5, 0.2, 0]) {
      renderDial(c, { minutes: 50, progress: p, gauge: 'segments' });
      counts.push(c.querySelectorAll('.ft-segment.is-on').length);
    }
    expect(counts).toEqual([50, 40, 25, 10, 0]);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeLessThan(counts[i - 1]);
  });
});

describe('renderDial — 갱신은 트리를 다시 만들지 않는다 (수용기준 36)', () => {
  it('두 번째 호출은 같은 노드를 재사용한다', () => {
    const c = makeContainer();
    const first = renderDial(c, { minutes: 25, progress: 1 });
    const svgBefore = c.querySelector('svg');
    const tickBefore = c.querySelector('.ft-tick');

    const second = renderDial(c, { minutes: 25, progress: 0.9 });

    expect(second).toBe(first);
    expect(c.querySelector('svg')).toBe(svgBefore);
    expect(c.querySelector('.ft-tick')).toBe(tickBefore);
    expect(c.querySelectorAll('.ft-dial').length).toBe(1);
  });

  it('1초 단위 60회 갱신 동안 sector 노드가 교체되지 않는다', () => {
    const c = makeContainer();
    renderDial(c, { minutes: 60, progress: 1, gauge: 'sector' });
    const sector = c.querySelector('.ft-sector');
    for (let i = 60; i >= 0; i -= 1) {
      renderDial(c, { minutes: 60, progress: i / 60, gauge: 'sector' });
      expect(c.querySelector('.ft-sector')).toBe(sector);
    }
    expect(sector.getAttribute('d')).toBe('M 100 100 Z');
  });

  it('segments 갱신 시 조각 노드가 그대로 유지된다', () => {
    const c = makeContainer();
    renderDial(c, { minutes: 30, progress: 1, gauge: 'segments' });
    const segs = [...c.querySelectorAll('.ft-segment')];
    renderDial(c, { minutes: 30, progress: 0.5, gauge: 'segments' });
    const after = [...c.querySelectorAll('.ft-segment')];
    expect(after.length).toBe(segs.length);
    after.forEach((n, i) => expect(n).toBe(segs[i]));
  });

  it('gauge 스타일이 바뀌면 게이지 레이어만 교체된다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 30, gauge: 'sector' });
    const tick = c.querySelector('.ft-tick');
    renderDial(c, { minutes: 30, gauge: 'segments' });
    expect(c.querySelector('.ft-tick')).toBe(tick); // 눈금은 유지
    expect(c.querySelector('.ft-sector')).toBe(null);
    expect(c.querySelectorAll('.ft-segment').length).toBe(60);
    expect(root.getAttribute('data-gauge')).toBe('segments');
  });
});

describe('수용기준 7 / §8 — ARIA', () => {
  it('idle: slider 활성, tabindex=0, aria-disabled=false', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 25, maxMinutes: 60, progress: 1, disabled: false });
    expect(root.getAttribute('role')).toBe('slider');
    expect(root.getAttribute('aria-valuemin')).toBe('1');
    expect(root.getAttribute('aria-valuemax')).toBe('60');
    expect(root.getAttribute('aria-valuenow')).toBe('25');
    expect(root.getAttribute('aria-valuetext')).toBe('25분');
    expect(root.getAttribute('aria-disabled')).toBe('false');
    expect(root.getAttribute('tabindex')).toBe('0');
  });

  it('running(disabled): aria-disabled=true, tabindex=-1 로 바뀐다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 25, disabled: false });
    renderDial(c, { minutes: 25, disabled: true });
    expect(root.getAttribute('aria-disabled')).toBe('true');
    expect(root.getAttribute('tabindex')).toBe('-1');
    // 다시 idle 로 돌아오면 복구
    renderDial(c, { minutes: 25, disabled: false });
    expect(root.getAttribute('aria-disabled')).toBe('false');
    expect(root.getAttribute('tabindex')).toBe('0');
  });

  it('aria-valuemax 는 maxMinutes 를 따른다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 20, maxMinutes: 30 });
    expect(root.getAttribute('aria-valuemax')).toBe('30');
    expect(root.getAttribute('aria-valuenow')).toBe('20');
  });

  it('aria-valuenow 는 maxMinutes 를 넘지 않는다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 90, maxMinutes: 60 });
    expect(root.getAttribute('aria-valuenow')).toBe('60');
  });

  it('단위/라벨을 주입할 수 있다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 5, unit: ' min', label: 'Focus minutes' });
    expect(root.getAttribute('aria-valuetext')).toBe('5 min');
    expect(root.getAttribute('aria-label')).toBe('Focus minutes');
  });

  it('svg 는 aria-hidden — 보조기술에는 slider 하나만 노출된다', () => {
    const c = makeContainer();
    const root = renderDial(c, { minutes: 5 });
    expect(root.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    // role="timer" 는 다이얼 안에 없다 (같은 요소 두 role 금지, spec §3.4)
    expect(root.querySelector('[role="timer"]')).toBe(null);
    expect(root.getAttribute('role')).not.toBe('timer');
  });
});

describe('applyStyles — CSP-safe 주입 (spec §9.2)', () => {
  it('adoptedStyleSheets 를 지원하면 그 경로를 쓴다', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const how = applyStyles(shadow, cssText);
    if (how === 'adopted') {
      expect(shadow.adoptedStyleSheets.length).toBe(1);
      expect(shadow.querySelector('style')).toBe(null);
    } else {
      expect(shadow.querySelector('style').textContent).toBe(cssText);
    }
  });

  it('CSSStyleSheet 생성이 막히면 <style> 로 폴백한다', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const original = globalThis.CSSStyleSheet;
    globalThis.CSSStyleSheet = function Broken() {
      throw new Error('blocked');
    };
    try {
      const how = applyStyles(shadow, cssText);
      expect(how).toBe('style-element');
      expect(shadow.querySelector('style').textContent).toBe(cssText);
    } finally {
      globalThis.CSSStyleSheet = original;
    }
  });

  it('shadow root 안에서도 다이얼이 만들어진다', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const root = renderDial(shadow, { minutes: 10 });
    expect(shadow.contains(root)).toBe(true);
    // 재호출 시 중복 생성 없음
    renderDial(shadow, { minutes: 11 });
    expect(shadow.querySelectorAll('.ft-dial').length).toBe(1);
  });
});

/* ── 수용기준 8: 6개 테마 대비 측정 ─────────────────────────────────── */

/** @param {string} hex @returns {number} WCAG 상대 휘도 */
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} a @param {string} b @returns {number} */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * styles.css 에서 `:host([theme="x"])` 블록의 CSS 변수들을 뽑는다.
 * auto 는 라이트/다크 두 블록이 나오므로 배열로 모은다.
 */
function parseThemes(css) {
  /** @type {Record<string, Array<Record<string,string>>>} */
  const out = {};
  const blockRe = /:host\(\[theme="([a-z]+)"\]\)[^{}]*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const name = m[1];
    /** @type {Record<string,string>} */
    const vars = {};
    const declRe = /(--ft-[a-z-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(m[2])) !== null) vars[d[1]] = d[2].trim();
    (out[name] = out[name] || []).push(vars);
  }
  return out;
}

describe('수용기준 8 — 6개 테마 대비 (텍스트 ≥ 4.5:1, 게이지/눈금 ≥ 3:1)', () => {
  const themes = parseThemes(cssText);

  it('6개 테마가 모두 정의되어 있다', () => {
    expect(Object.keys(themes).sort()).toEqual(
      ['auto', 'classic', 'dark', 'pink', 'purple', 'sky'].sort(),
    );
  });

  it('공개 테마 변수 이름이 spec §9.1 그대로다', () => {
    const required = ['--ft-bg', '--ft-gauge', '--ft-track', '--ft-text', '--ft-mark'];
    for (const [name, blocks] of Object.entries(themes)) {
      for (const vars of blocks) {
        for (const key of required) {
          expect(vars[key], `${name} 테마에 ${key} 없음`).toBeTruthy();
          expect(vars[key]).toMatch(/^#[0-9a-f]{3,6}$/i);
        }
      }
    }
    // --ft-font / --ft-radius 는 기본 블록에 존재
    expect(cssText).toContain('--ft-font');
    expect(cssText).toContain('--ft-radius');
  });

  for (const name of ['auto', 'classic', 'purple', 'pink', 'sky', 'dark']) {
    it(`${name}: 텍스트 ≥ 4.5:1, 게이지·눈금 ≥ 3:1`, () => {
      const blocks = parseThemes(cssText)[name];
      expect(blocks.length).toBeGreaterThan(0);
      for (const v of blocks) {
        const bg = v['--ft-bg'];
        expect(contrast(v['--ft-text'], bg), `${name} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v['--ft-gauge'], bg), `${name} gauge`).toBeGreaterThanOrEqual(3);
        expect(contrast(v['--ft-mark'], bg), `${name} mark`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('auto 는 라이트 + prefers-color-scheme: dark 두 벌을 갖는다', () => {
    expect(parseThemes(cssText).auto.length).toBe(2);
    expect(cssText).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe('styles.css — 접근성/패키징 요구사항', () => {
  it(':host 가 폰트/색을 상속한다 (spec §9.1)', () => {
    expect(cssText).toMatch(/:host\s*\{[^}]*font:\s*inherit/);
    expect(cssText).toMatch(/:host\s*\{[^}]*color:\s*inherit/);
  });

  it('prefers-reduced-motion: reduce 에서 전환을 제거한다 (수용기준 31)', () => {
    expect(cssText).toContain('@media (prefers-reduced-motion: reduce)');
    const block = cssText.split('@media (prefers-reduced-motion: reduce)')[1];
    expect(block).toContain('transition: none');
    expect(block).toContain('animation: none');
  });

  it('forced-colors: active 에서 두께/패턴으로 잔량을 구분한다 (spec §8)', () => {
    expect(cssText).toContain('@media (forced-colors: active)');
    const block = cssText.split('@media (forced-colors: active)')[1];
    expect(block).toContain('stroke-width');
    expect(block).toContain('stroke-dasharray');
    expect(block).toContain('Highlight');
  });

  it('touch-action: none 은 다이얼에만 걸린다 (spec §3.2)', () => {
    const hits = cssText.match(/touch-action:\s*none/g) || [];
    expect(hits.length).toBe(1);
    expect(cssText).toMatch(/\.ft-dial\s*\{[^}]*touch-action:\s*none/);
  });

  it('터치 타깃 ≥ 44px (수용기준 §8)', () => {
    const dial = cssText.match(/\.ft-dial\s*\{([^}]*)\}/)[1];
    const minW = Number(dial.match(/min-width:\s*(\d+)px/)[1]);
    const minH = Number(dial.match(/min-height:\s*(\d+)px/)[1]);
    expect(minW).toBeGreaterThanOrEqual(44);
    expect(minH).toBeGreaterThanOrEqual(44);
  });
});
