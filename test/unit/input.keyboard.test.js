/**
 * input/keyboard.js 단위 테스트 (jsdom).
 * 수용 기준 7(running 중 거부), 30(키보드만으로 완주) + spec §8 "Space 전역 단축키 금지".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachKeyboard,
  attachPreset,
  attachDelta,
  attachNumberInput,
  clampMinutes,
  PRESET_MINUTES,
  DELTA_STEPS,
} from '../../src/input/keyboard.js';

let dial;
let handle;
let cb;

function key(k, target = dial, init = {}) {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  dial = document.createElement('div');
  dial.setAttribute('role', 'slider');
  dial.setAttribute('tabindex', '0');
  document.body.appendChild(dial);
  cb = { onDelta: vi.fn(), onSet: vi.fn(), onActivate: vi.fn() };
});

afterEach(() => {
  if (handle) handle.detach();
  handle = null;
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

describe('attachKeyboard — 키 매핑 (spec §3.3, 기준 30)', () => {
  beforeEach(() => {
    handle = attachKeyboard(dial, cb);
    dial.focus();
  });

  it('←/→ 는 ±1분', () => {
    key('ArrowRight');
    expect(cb.onDelta).toHaveBeenLastCalledWith(1);
    key('ArrowLeft');
    expect(cb.onDelta).toHaveBeenLastCalledWith(-1);
  });

  it('↑/↓ 는 ±5분', () => {
    key('ArrowUp');
    expect(cb.onDelta).toHaveBeenLastCalledWith(5);
    key('ArrowDown');
    expect(cb.onDelta).toHaveBeenLastCalledWith(-5);
  });

  it('PageUp/PageDown 은 ±5분', () => {
    key('PageUp');
    expect(cb.onDelta).toHaveBeenLastCalledWith(5);
    key('PageDown');
    expect(cb.onDelta).toHaveBeenLastCalledWith(-5);
  });

  it('Home/End 는 최소/최대값을 절대 지정한다', () => {
    key('Home');
    expect(cb.onSet).toHaveBeenLastCalledWith(1);
    key('End');
    expect(cb.onSet).toHaveBeenLastCalledWith(60);
    expect(cb.onDelta).not.toHaveBeenCalled();
  });

  it('min/max 옵션이 Home/End 값을 바꾼다', () => {
    handle.detach();
    handle = attachKeyboard(dial, { ...cb, min: 5, max: 45 });
    dial.focus();
    key('Home');
    expect(cb.onSet).toHaveBeenLastCalledWith(5);
    key('End');
    expect(cb.onSet).toHaveBeenLastCalledWith(45);
  });

  it('처리한 키는 preventDefault (Space 스크롤 방지), 모르는 키는 그대로 흘린다', () => {
    expect(key('ArrowRight').defaultPrevented).toBe(true);
    expect(key(' ').defaultPrevented).toBe(true);
    expect(key('a').defaultPrevented).toBe(false);
  });

  it('수정키(Ctrl/Alt/Meta) 조합은 브라우저 단축키로 넘긴다', () => {
    key('ArrowRight', dial, { ctrlKey: true });
    key('ArrowRight', dial, { altKey: true });
    key('ArrowRight', dial, { metaKey: true });
    expect(cb.onDelta).not.toHaveBeenCalled();
  });

  it('detach 후에는 아무 키도 처리하지 않는다', () => {
    handle.detach();
    handle = null;
    key('ArrowRight');
    expect(cb.onDelta).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — Space/Enter 전역 단축키 금지 (spec §8)', () => {
  it('다이얼에 포커스가 있을 때만 Space/Enter 가 동작한다', () => {
    handle = attachKeyboard(dial, cb);
    dial.focus();
    key(' ');
    expect(cb.onActivate).toHaveBeenCalledTimes(1);
    key('Enter');
    expect(cb.onActivate).toHaveBeenCalledTimes(2);
  });

  it('포커스가 다른 곳에 있으면 다이얼 위 Space 도 무시된다', () => {
    handle = attachKeyboard(dial, cb);
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);
    const ev = key(' ');
    expect(cb.onActivate).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false); // 페이지 스크롤 기본동작 유지
  });

  it('document/body 에는 어떤 리스너도 붙지 않는다 (전역 Space 없음)', () => {
    handle = attachKeyboard(dial, cb);
    dial.focus();
    key(' ', document.body);
    key(' ', document);
    key('ArrowRight', document.body);
    expect(cb.onActivate).not.toHaveBeenCalled();
    expect(cb.onDelta).not.toHaveBeenCalled();
  });

  it('onActivate 를 안 넘기면 Space 는 아무 일도 하지 않는다', () => {
    handle = attachKeyboard(dial, { onDelta: cb.onDelta, onSet: cb.onSet });
    dial.focus();
    expect(() => key(' ')).not.toThrow();
    expect(cb.onDelta).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — running 중 거부 (기준 7, spec §3.4)', () => {
  it('aria-disabled="true" 면 모든 키가 no-op', () => {
    dial.setAttribute('aria-disabled', 'true');
    handle = attachKeyboard(dial, cb);
    dial.focus();
    key('ArrowRight');
    key('Home');
    key(' ');
    expect(cb.onDelta).not.toHaveBeenCalled();
    expect(cb.onSet).not.toHaveBeenCalled();
    expect(cb.onActivate).not.toHaveBeenCalled();
  });

  it('setDisabled(true/false) 로 켜고 끌 수 있다', () => {
    handle = attachKeyboard(dial, cb);
    dial.focus();
    handle.setDisabled(true);
    key('ArrowRight');
    expect(cb.onDelta).not.toHaveBeenCalled();
    handle.setDisabled(false);
    key('ArrowRight');
    expect(cb.onDelta).toHaveBeenCalledWith(1);
  });

  it('disabled 게터도 존중한다', () => {
    let running = true;
    handle = attachKeyboard(dial, { ...cb, disabled: () => running });
    dial.focus();
    key('ArrowUp');
    expect(cb.onDelta).not.toHaveBeenCalled();
    running = false;
    key('ArrowUp');
    expect(cb.onDelta).toHaveBeenCalledWith(5);
  });
});

describe('병렬 입력 수단 헬퍼 (spec §3.3)', () => {
  it('프리셋/델타 상수는 명세값과 일치한다', () => {
    expect([...PRESET_MINUTES]).toEqual([5, 10, 25, 50]);
    expect([...DELTA_STEPS]).toEqual([-5, -1, 1, 5]);
  });

  it('clampMinutes 는 [1,60] 정수로 정규화하고 비수치는 null', () => {
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(61)).toBe(60);
    expect(clampMinutes('25')).toBe(25);
    expect(clampMinutes(25.6)).toBe(26);
    expect(clampMinutes('abc')).toBe(null);
    expect(clampMinutes(0, 0, 60)).toBe(0);
  });

  it('attachPreset 은 클릭 시 절대값을 세팅하고 detach 가능하다', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const off = attachPreset(btn, 25, cb.onSet);
    btn.click();
    expect(cb.onSet).toHaveBeenCalledWith(25);
    off();
    btn.click();
    expect(cb.onSet).toHaveBeenCalledTimes(1);
  });

  it('attachDelta 는 클릭 시 상대값을 보낸다', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const off = attachDelta(btn, -5, cb.onDelta);
    btn.click();
    expect(cb.onDelta).toHaveBeenCalledWith(-5);
    off();
  });

  it('attachNumberInput 은 입력을 클램프하고 change 시 표시값도 정정한다', () => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '60';
    document.body.appendChild(input);
    const off = attachNumberInput(input, cb.onSet);

    input.value = '30';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cb.onSet).toHaveBeenLastCalledWith(30);

    input.value = '999';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cb.onSet).toHaveBeenLastCalledWith(60);
    expect(input.value).toBe('60');

    cb.onSet.mockClear();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(cb.onSet).not.toHaveBeenCalled();
    off();
  });
});
