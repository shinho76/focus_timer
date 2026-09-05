/**
 * input/pointer.js 단위 테스트 (jsdom).
 * 수용 기준 1, 2, 3, 4, 7 의 단위 테스트 가능한 부분을 증명한다.
 *
 * jsdom 은 PointerEvent 와 setPointerCapture 를 구현하지 않는다 →
 * 이 파일 안에서만 이벤트 팩토리와 캡처 스텁을 만든다 (프로덕션 코드는 손대지 않음).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachPointer } from '../../src/input/pointer.js';

const R = 100; // dial radius
const CX = 100;
const CY = 100;
const TRACK = 80; // 드래그 궤적 반지름 (데드존 20 밖)

/** 분(m)에 해당하는 화면 좌표. 0분 = 12시, 시계방향. */
function at(minutes, radius = TRACK) {
  const th = (minutes * 6 * Math.PI) / 180;
  return { clientX: CX + radius * Math.sin(th), clientY: CY - radius * Math.cos(th) };
}

function makeEvent(type, props = {}) {
  const { pointerId = 1, isPrimary = true, ...rest } = props;
  const Ctor = globalThis.PointerEvent || globalThis.MouseEvent;
  let ev;
  try {
    ev = new Ctor(type, { bubbles: true, cancelable: true, ...rest });
  } catch {
    ev = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(rest)) {
      Object.defineProperty(ev, k, { value: v, configurable: true });
    }
  }
  if (ev.pointerId === undefined) {
    Object.defineProperty(ev, 'pointerId', { value: pointerId, configurable: true });
  }
  if (ev.isPrimary === undefined) {
    Object.defineProperty(ev, 'isPrimary', { value: isPrimary, configurable: true });
  }
  return ev;
}

let dial;
let parent;
let handle;
let cb;

function fire(type, props) {
  const ev = makeEvent(type, props);
  dial.dispatchEvent(ev);
  return ev;
}

/** 시작 분에서 목표 분까지 여러 스텝으로 부드럽게 드래그. */
function dragTo(fromMin, toMin, step = 1, extra = {}) {
  const dir = toMin >= fromMin ? 1 : -1;
  for (let m = fromMin + dir * step; dir > 0 ? m <= toMin : m >= toMin; m += dir * step) {
    fire('pointermove', { ...at(m), ...extra });
  }
}

beforeEach(() => {
  parent = document.createElement('div');
  dial = document.createElement('div');
  parent.appendChild(dial);
  document.body.appendChild(parent);

  dial.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 2 * R, bottom: 2 * R, width: 2 * R, height: 2 * R, x: 0, y: 0,
  });
  // jsdom 미구현 API 스텁
  const captured = new Set();
  dial.setPointerCapture = vi.fn((id) => captured.add(id));
  dial.releasePointerCapture = vi.fn((id) => captured.delete(id));
  dial.hasPointerCapture = (id) => captured.has(id);

  cb = {
    onAngleChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onUnlockHint: vi.fn(),
  };
});

afterEach(() => {
  if (handle) handle.detach();
  handle = null;
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

describe('attachPointer — 기본 배선', () => {
  it('touch-action: none 을 인라인 style 로 다이얼에 걸지 않는다 (CSP style-src 위반 방지 — view/styles.css 의 정적 .ft-dial 규칙이 담당)', () => {
    // element.style.* 대입은 CSP `style-src 'self'` 아래에서 인라인 스타일로
    // 취급되어 차단된다(demo/csp-test.html 로 재현 확인). touch-action 은
    // view/styles.css 의 정적 규칙이 이미 다이얼에만 스코프해서 걸어두므로
    // pointer.js 는 인라인으로 손대지 않는다 — 조상 오염 여지 자체가 없다.
    handle = attachPointer(dial, cb);
    expect(dial.style.touchAction || '').toBe('');
    expect(parent.style.touchAction || '').toBe('');
    expect(document.body.style.touchAction || '').toBe('');
    expect(document.documentElement.style.touchAction || '').toBe('');
  });

  it('detach 하면 리스너가 사라지고 드래그 클래스가 남지 않는다', () => {
    const h = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    h.detach();
    expect(dial.classList.contains('is-dragging')).toBe(false);
    fire('pointermove', at(10));
    expect(cb.onAngleChange).not.toHaveBeenCalled();
  });

  it('pointerdown 에서 setPointerCapture(pointerId) 를 호출한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', { ...at(0), pointerId: 7 });
    expect(dial.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it('pointerdown 이 오디오 언락 훅(onUnlockHint)을 호출한다 (spec §2.2/§5.3)', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    expect(cb.onUnlockHint).toHaveBeenCalledTimes(1);
  });

  it('드래그 중 is-dragging 클래스로 user-select 를 막고, 종료 시 뗀다 (인라인 style 아님 — CSP 안전)', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    expect(dial.classList.contains('is-dragging')).toBe(true);
    expect(dial.style.userSelect || '').toBe('');
    fire('pointerup', at(5));
    expect(dial.classList.contains('is-dragging')).toBe(false);
  });
});

describe('attachPointer — 각도 → 분 (기준 1)', () => {
  it('6° = 1분: 10분 위치로 드래그하면 10분이 나오고 release 시 commit', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 10);
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(10);
    fire('pointerup', at(10));
    expect(cb.onCommit).toHaveBeenCalledWith(10);
    expect(cb.onCancel).not.toHaveBeenCalled();
  });

  it('드래그 시작값은 aria-valuenow 에서 읽는다 (상대 회전)', () => {
    dial.setAttribute('aria-valuenow', '25');
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(25));
    dragTo(25, 30);
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(30);
  });

  it('getMinutes 옵션이 aria-valuenow 보다 우선한다', () => {
    dial.setAttribute('aria-valuenow', '25');
    handle = attachPointer(dial, { ...cb, getMinutes: () => 40 });
    fire('pointerdown', at(40));
    dragTo(40, 43);
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(43);
  });

  it('Shift 드래그는 5분 스냅', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 12, 1, { shiftKey: true });
    const values = cb.onAngleChange.mock.calls.map((c) => c[0]);
    expect(values.every((v) => v % 5 === 0)).toBe(true);
    expect(values[values.length - 1]).toBe(10);
  });

  it('데드존 밖을 움직임 없이 클릭만 하고 떼면, 그 위치가 가리키는 시간으로 바로 commit 된다 (디자인 요청: 분침 근처 클릭 = 해당 시간 설정)', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(15)); // 현재값(0)과 다른 위치를 곧장 클릭
    fire('pointerup', at(15)); // 중간에 pointermove 없음 — 순수 클릭
    expect(cb.onAngleChange).not.toHaveBeenCalled();
    expect(cb.onCommit).toHaveBeenCalledWith(15);
  });

  it('클릭 후 이어서 끌면, 클릭 지점을 새 기준으로 상대 회전이 이어진다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(15)); // 15분 지점을 클릭 — 그 지점이 새 기준
    dragTo(15, 20); // 거기서 5분 더 회전
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(20);
  });
});

describe('attachPointer — 0/60 경계 (기준 2)', () => {
  it('59 → 0 방향으로 넘겨도 되감기지 않고 60에서 클램프된다', () => {
    dial.setAttribute('aria-valuenow', '59');
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(59));
    // 59 → 60(=0시 방향) → 계속 시계방향으로 5분치 더
    for (const m of [59.5, 60, 61, 63, 65]) fire('pointermove', at(m));
    const values = cb.onAngleChange.mock.calls.map((c) => c[0]);
    // 단조 비감소: 어떤 시점에도 이전 값보다 작아지지 않는다 (= 0으로 튀지 않음)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(59);
    expect(values[values.length - 1]).toBe(60);
    fire('pointerup', at(65));
    expect(cb.onCommit).toHaveBeenCalledWith(60);
  });

  it('0 → 59 방향(반시계)으로 내려도 0에서 클램프되고 59로 튀지 않는다', () => {
    dial.setAttribute('aria-valuenow', '1');
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(1));
    for (const m of [0.5, 0, -1, -3, -5]) fire('pointermove', at(m));
    const values = cb.onAngleChange.mock.calls.map((c) => c[0]);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(values[values.length - 1]).toBe(0);
  });

  it('한 바퀴를 다 돌려도 60을 넘겨 0으로 순환하지 않는다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 75, 1); // 60분을 넘겨 계속 회전
    const values = cb.onAngleChange.mock.calls.map((c) => c[0]);
    expect(Math.max(...values)).toBe(60);
    expect(values[values.length - 1]).toBe(60);
  });

  it('0분에서 손을 떼면 commit 대신 cancel (시작할 값이 없음)', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    fire('pointermove', at(0));
    fire('pointerup', at(0));
    expect(cb.onCommit).not.toHaveBeenCalled();
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('attachPointer — 롤백/취소 (기준 3)', () => {
  it('pointercancel 이 onCancel 을 호출하고 commit 하지 않는다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 8);
    fire('pointercancel', at(8));
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
    expect(cb.onCommit).not.toHaveBeenCalled();
    expect(handle.isDragging()).toBe(false);
  });

  it('pointercancel 이후의 pointermove 는 무시된다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 8);
    fire('pointercancel', at(8));
    cb.onAngleChange.mockClear();
    fire('pointermove', at(20));
    expect(cb.onAngleChange).not.toHaveBeenCalled();
  });

  it('드래그 중 lostpointercapture 는 롤백한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 8);
    fire('lostpointercapture', {});
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
    expect(cb.onCommit).not.toHaveBeenCalled();
  });

  it('정상 pointerup 뒤에 오는 lostpointercapture 는 롤백하지 않는다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 8);
    fire('pointerup', at(8));
    fire('lostpointercapture', {});
    expect(cb.onCommit).toHaveBeenCalledWith(8);
    expect(cb.onCancel).not.toHaveBeenCalled();
  });

  it('pointerup 에서 releasePointerCapture 를 호출한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', { ...at(0), pointerId: 3 });
    fire('pointerup', { ...at(4), pointerId: 3 });
    expect(dial.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it('다이얼 밖(반경 밖) 좌표로 나가도 추적을 유지한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    fire('pointermove', at(15, 400)); // 다이얼 반경 훨씬 밖
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(15);
  });
});

describe('attachPointer — 노이즈/입력 거부', () => {
  it('중심 근처(반경 20% 미만) 이동은 무시한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    fire('pointermove', at(30, 5)); // 중심에서 5px
    expect(cb.onAngleChange).not.toHaveBeenCalled();
    fire('pointermove', at(3)); // 데드존 밖으로 나오면 다시 동작
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(3);
  });

  it('minRadiusRatio 를 0 으로 주면 데드존이 사라진다', () => {
    handle = attachPointer(dial, { ...cb, minRadiusRatio: 0 });
    fire('pointerdown', at(0));
    fire('pointermove', at(30, 5));
    expect(cb.onAngleChange).toHaveBeenCalled();
  });

  it('우클릭(button=2)은 드래그를 시작하지 않는다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', { ...at(0), button: 2 });
    expect(handle.isDragging()).toBe(false);
    expect(cb.onUnlockHint).not.toHaveBeenCalled();
    fire('pointermove', at(10));
    expect(cb.onAngleChange).not.toHaveBeenCalled();
  });

  it('두 번째 동시 포인터(멀티터치)는 무시한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', { ...at(0), pointerId: 1 });
    fire('pointerdown', { ...at(30), pointerId: 2, isPrimary: false });
    cb.onAngleChange.mockClear();
    fire('pointermove', { ...at(30), pointerId: 2 }); // 두 번째 손가락 이동
    expect(cb.onAngleChange).not.toHaveBeenCalled();
    fire('pointermove', { ...at(6), pointerId: 1 }); // 첫 포인터는 정상
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(6);
  });
});

describe('attachPointer — running 중 조작 거부 (기준 7, spec §3.4)', () => {
  it('aria-disabled="true" 면 드래그가 아무 값도 만들지 않는다', () => {
    dial.setAttribute('aria-disabled', 'true');
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 10);
    fire('pointerup', at(10));
    expect(cb.onAngleChange).not.toHaveBeenCalled();
    expect(cb.onCommit).not.toHaveBeenCalled();
    expect(handle.isDragging()).toBe(false);
  });

  it('disabled 게터로도 막힌다', () => {
    let running = true;
    handle = attachPointer(dial, { ...cb, disabled: () => running });
    fire('pointerdown', at(0));
    dragTo(0, 10);
    expect(cb.onAngleChange).not.toHaveBeenCalled();
    running = false;
    fire('pointerdown', at(0));
    dragTo(0, 10);
    expect(cb.onAngleChange).toHaveBeenLastCalledWith(10);
  });

  it('setDisabled(true) 는 진행 중인 드래그도 롤백한다', () => {
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    dragTo(0, 10);
    handle.setDisabled(true);
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
    expect(handle.isDragging()).toBe(false);
    cb.onAngleChange.mockClear();
    fire('pointerdown', at(0));
    dragTo(0, 5);
    expect(cb.onAngleChange).not.toHaveBeenCalled();
  });

  it('disabled 여도 onUnlockHint 는 호출된다 (오디오 재언락 기회, spec §5.3)', () => {
    dial.setAttribute('aria-disabled', 'true');
    handle = attachPointer(dial, cb);
    fire('pointerdown', at(0));
    expect(cb.onUnlockHint).toHaveBeenCalledTimes(1);
  });
});
