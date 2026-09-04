import { describe, it, expect, beforeEach } from 'vitest';
import { renderReadout, formatValue } from '../../src/view/readout.js';
import { renderDial } from '../../src/view/dial.js';

/** @returns {HTMLDivElement} */
function makeContainer() {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

/** @param {Element} root */
function valueOf(root) {
  return root.querySelector('.ft-readout-value').textContent;
}

/** @param {Element} root */
function unitEl(root) {
  return root.querySelector('.ft-readout-unit');
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('formatValue — 분 기본, ≤60초에서 M:SS (spec §3.1, 수용기준 5)', () => {
  it('showSeconds=false 면 분만 표시한다', () => {
    expect(formatValue(23, 41, false)).toBe('23');
    expect(formatValue(50, 0, false)).toBe('50');
    expect(formatValue(1, 59, false)).toBe('1');
    expect(formatValue(0, 30, false)).toBe('0');
  });

  it('showSeconds=true 면 M:SS 로 0 패딩한다', () => {
    expect(formatValue(0, 59, true)).toBe('0:59');
    expect(formatValue(0, 9, true)).toBe('0:09');
    expect(formatValue(0, 0, true)).toBe('0:00');
    expect(formatValue(1, 0, true)).toBe('1:00');
  });

  it('초는 0~59 로 클램프된다', () => {
    expect(formatValue(0, 60, true)).toBe('0:59');
    expect(formatValue(0, -5, true)).toBe('0:00');
  });

  it('음수 분은 0 으로 본다 (표시 잔여 시간은 음수가 되지 않는다)', () => {
    expect(formatValue(-3, 0, false)).toBe('0');
  });
});

describe('renderReadout — DOM 구조', () => {
  it('숫자 + 단위 라벨 구조를 만든다', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 23, seconds: 0, showSeconds: false });
    expect(root.classList.contains('ft-readout')).toBe(true);
    expect(root.getAttribute('part')).toBe('readout');
    expect(valueOf(root)).toBe('23');
    expect(unitEl(root).textContent).toBe('분');
    expect(unitEl(root).hidden).toBe(false);
  });

  it('단위 라벨을 주입할 수 있다', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 23, unit: 'min' });
    expect(unitEl(root).textContent).toBe('min');
  });

  it('shadow root 안에도 붙일 수 있다', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const root = renderReadout(shadow, { minutes: 5 });
    expect(shadow.contains(root)).toBe(true);
    renderReadout(shadow, { minutes: 4 });
    expect(shadow.querySelectorAll('.ft-readout').length).toBe(1);
  });
});

describe('renderReadout — M:SS 전환 (수용기준 5)', () => {
  it('showSeconds 가 켜지면 M:SS 로 바뀌고 단위 라벨을 숨긴다', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 1, seconds: 5, showSeconds: false });
    expect(valueOf(root)).toBe('1');
    expect(root.getAttribute('data-format')).toBe('minutes');

    renderReadout(c, { minutes: 0, seconds: 59, showSeconds: true });
    expect(valueOf(root)).toBe('0:59');
    expect(unitEl(root).hidden).toBe(true);
    expect(root.getAttribute('data-format')).toBe('ms');
  });

  it('다시 분 표시로 돌아오면 단위 라벨이 살아난다 (리셋 등)', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 0, seconds: 30, showSeconds: true });
    renderReadout(c, { minutes: 25, seconds: 0, showSeconds: false });
    expect(valueOf(root)).toBe('25');
    expect(unitEl(root).hidden).toBe(false);
    expect(unitEl(root).textContent).toBe('분');
  });

  it('60초 카운트다운이 단조 감소한다 (중복·역행 없음)', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 1, seconds: 0, showSeconds: false });
    const seen = [valueOf(root)];
    for (let s = 59; s >= 0; s -= 1) {
      renderReadout(c, { minutes: 0, seconds: s, showSeconds: true });
      seen.push(valueOf(root));
    }
    expect(seen[0]).toBe('1');
    expect(seen[1]).toBe('0:59');
    expect(seen[seen.length - 1]).toBe('0:00');
    const secs = seen.slice(1).map((t) => {
      const [m, ss] = t.split(':');
      return Number(m) * 60 + Number(ss);
    });
    for (let i = 1; i < secs.length; i += 1) expect(secs[i]).toBeLessThan(secs[i - 1]);
  });
});

describe('renderReadout — 갱신은 트리를 다시 만들지 않는다 (수용기준 36)', () => {
  it('같은 노드를 재사용하고 textContent 만 바꾼다', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 25 });
    const valueNode = root.querySelector('.ft-readout-value');
    const unitNode = unitEl(root);

    for (let m = 24; m >= 0; m -= 1) {
      const again = renderReadout(c, { minutes: m });
      expect(again).toBe(root);
      expect(root.querySelector('.ft-readout-value')).toBe(valueNode);
      expect(unitEl(root)).toBe(unitNode);
    }
    expect(c.querySelectorAll('.ft-readout').length).toBe(1);
    expect(valueOf(root)).toBe('0');
  });
});

describe('접근성 — role 분리 (spec §3.4, §8)', () => {
  it('중앙 숫자는 role="timer" + aria-live="off"', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 25 });
    expect(root.getAttribute('role')).toBe('timer');
    expect(root.getAttribute('aria-live')).toBe('off');
  });

  it('slider 와 timer 가 서로 다른 요소에 있다', () => {
    const widget = makeContainer();
    const dial = renderDial(widget, { minutes: 25, maxMinutes: 60 });
    const readout = renderReadout(widget, { minutes: 25 });

    expect(dial).not.toBe(readout);
    expect(dial.getAttribute('role')).toBe('slider');
    expect(readout.getAttribute('role')).toBe('timer');
    expect(dial.contains(readout)).toBe(false);
    expect(widget.querySelectorAll('[role="slider"]').length).toBe(1);
    expect(widget.querySelectorAll('[role="timer"]').length).toBe(1);
  });

  it('리드아웃에는 aria-valuenow 류 slider 속성이 없다', () => {
    const c = makeContainer();
    const root = renderReadout(c, { minutes: 25 });
    for (const attr of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext']) {
      expect(root.hasAttribute(attr)).toBe(false);
    }
  });
});
