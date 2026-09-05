/**
 * input/pointer.js — 다이얼 포인터(마우스/터치/펜) 드래그 배선.
 *
 * 이 모듈은 DOM 이벤트 배선만 담당한다. 각도 → 분 변환의 순수 수학은
 * core/angle.js 가 단일 진실 원천이며 여기서 재정의하지 않는다. (CLAUDE.md 모듈 계약)
 *
 * 명세 대응: spec-v4 §2.2(idle→setting→running), §3.2(드래그 요구사항 전부), §3.4(running 중 거부)
 * 수용 기준: 1, 2, 3, 4, 7
 */

import { angleToAccum, accumToMinutes, minutesToAccum, pointToAngle } from '../core/angle.js';

/** @typedef {(minutes: number) => void} MinutesCallback */

/**
 * @typedef {object} PointerOptions
 * @property {MinutesCallback} [onAngleChange] 드래그 중 연속 호출. 인자는 1분 스냅된 정수 분.
 * @property {MinutesCallback} [onCommit]      유효한 release(손 뗌) 시 1회 호출 → 자동 시작 트리거.
 * @property {() => void}      [onCancel]      pointercancel / lostpointercapture / 무효 release 시 롤백 요청.
 * @property {() => void}      [onUnlockHint]  pointerdown 제스처 시점 훅 (AudioContext.resume 용, spec §2.2/§5.3).
 * @property {number}          [minRadiusRatio=0.2] 다이얼 반경 대비 이 비율 미만 거리의 이동은 무시(중심부 각도 노이즈).
 * @property {() => number}    [getMinutes]    드래그 시작 시점의 현재 분(누적각 초기값). 없으면 aria-valuenow 를 읽는다.
 * @property {() => boolean}   [disabled]      true 면 모든 조작을 no-op (running/paused/ringing).
 * @property {number}          [minMinutes=1]  이 값 미만으로 손을 떼면 commit 대신 cancel.
 * @property {number}          [maxMinutes=60] 상한(각도 클램프는 angle.js 가 360°로 이미 처리).
 */

/**
 * @typedef {object} PointerHandle
 * @property {() => void} detach            리스너·인라인 스타일 원복.
 * @property {(v: boolean|null) => void} setDisabled  뷰가 running 진입 시 호출. null 이면 속성/게터 판정으로 되돌린다.
 * @property {() => boolean} isDragging
 */

const DEG = 180 / Math.PI;

/**
 * 다이얼 요소에 포인터 드래그를 배선한다.
 * @param {HTMLElement|SVGElement} dialEl
 * @param {PointerOptions} [options]
 * @returns {PointerHandle}
 */
export function attachPointer(dialEl, options = {}) {
  const {
    onAngleChange,
    onCommit,
    onCancel,
    onUnlockHint,
    minRadiusRatio = 0.2,
    getMinutes,
    disabled,
    minMinutes = 1,
    maxMinutes = 60,
  } = options;

  if (!dialEl) throw new TypeError('attachPointer: dialEl is required');

  /**
   * touch-action: none 은 다이얼 요소에만 (spec §3.2, 기준 4) — view/styles.css 의
   * 정적 `.ft-dial` 규칙이 이미 스코프를 지킨 채로 이 값을 건다. 여기서
   * `dialEl.style.touchAction = ...` 로 인라인 설정을 또 하지 않는 이유: CSP
   * `style-src 'self'` 아래에서는 <style>/style="" 뿐 아니라 JS 의
   * `element.style.*` 대입도 인라인 스타일로 취급되어 차단된다(spec §9.2,
   * 기준 34) — 실제로 demo/csp-test.html 로 재현 확인했다. user-select 도
   * 같은 이유로 인라인 대신 클래스 토글(`is-dragging`)을 쓴다 — 스타일시트
   * 자체는 adoptedStyleSheets/<style> 로 이미 허용된 경로라 클래스 토글은
   * CSP 위반이 아니다.
   */
  const DRAG_CLASS = 'is-dragging';

  /** @type {number|null} */
  let activePointerId = null;
  let accum = 0;
  let lastAngle = 0;
  let lastMinutes = 0;
  let moved = false;
  let disabledFlag = /** @type {boolean|null} */ (null);
  /** 캡처 폴백으로 document 리스너를 붙였을 때 같은 이벤트를 두 번 처리하지 않기 위한 가드 */
  let lastHandledEvent = null;
  let docListening = false;

  const doc = dialEl.ownerDocument || (typeof document !== 'undefined' ? document : null);

  function isDisabled() {
    if (disabledFlag === true) return true;
    if (typeof disabled === 'function' && disabled()) return true;
    return dialEl.getAttribute && dialEl.getAttribute('aria-disabled') === 'true';
  }

  function readCurrentMinutes() {
    if (typeof getMinutes === 'function') {
      const n = Number(getMinutes());
      return Number.isFinite(n) ? n : 0;
    }
    const attr = dialEl.getAttribute && dialEl.getAttribute('aria-valuenow');
    const n = Number(attr);
    return Number.isFinite(n) && attr !== null && attr !== '' ? n : 0;
  }

  function geometry() {
    const r = dialEl.getBoundingClientRect();
    return {
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      radius: Math.min(r.width, r.height) / 2,
    };
  }

  /** 화면 좌표 → 각도(도). y 가 아래로 증가하므로 증가 방향 = 시계방향 = 분 증가. */
  function angleAt(e, g) {
    return Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * DEG;
  }

  function snap(minutes, shiftKey) {
    // spec §0.3: 기본 1분 스냅, Shift 드래그 시 5분 스냅.
    const m = shiftKey ? Math.round(minutes / 5) * 5 : minutes;
    return Math.max(0, Math.min(maxMinutes, m));
  }

  function beginDrag(e) {
    activePointerId = e.pointerId;
    moved = false;
    const g = geometry();
    lastAngle = angleAt(e, g);

    const dx = e.clientX - g.cx;
    const dy = e.clientY - g.cy;
    const inDeadZone = !(g.radius > 0) || Math.hypot(dx, dy) < minRadiusRatio * g.radius;

    if (inDeadZone) {
      // 중심 근처는 각도가 불안정하므로 기존처럼 현재 값에서 드래그를 이어간다.
      lastMinutes = readCurrentMinutes();
    } else {
      // 분침/눈금 근처(데드존 밖)를 클릭하면 그 위치가 가리키는 시간으로 드래그를
      // 시작한다(디자인 요청: "분침 근처를 클릭하면 해당 시간으로 설정"). 그대로
      // 손을 떼면 onCommit 이 이 값을 그대로 커밋하고, 계속 끌면 여기서부터 상대
      // 회전이 이어진다. pointToAngle 은 accum 과 같은 각도 좌표계(0°=12시,
      // 시계방향)라 변환 없이 그대로 accumToMinutes 에 넣을 수 있다.
      lastMinutes = snap(accumToMinutes(pointToAngle(dx, dy)), e.shiftKey);
    }
    accum = minutesToAccum(lastMinutes);

    dialEl.classList.add(DRAG_CLASS); // 드래그 중 텍스트 선택 방지 (spec §3.2) — CSS 클래스로, 인라인 style 로 하지 않는다
  }

  function endDrag() {
    activePointerId = null;
    moved = false;
    dialEl.classList.remove(DRAG_CLASS);
    stopDocFallback();
  }

  function startDocFallback() {
    if (docListening || !doc) return;
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerCancel, true);
    docListening = true;
  }

  function stopDocFallback() {
    if (!docListening || !doc) return;
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    docListening = false;
  }

  function alreadyHandled(e) {
    if (lastHandledEvent === e) return true;
    lastHandledEvent = e;
    return false;
  }

  function onPointerDown(e) {
    if (alreadyHandled(e)) return;
    // 우클릭/보조버튼 무시.
    if (typeof e.button === 'number' && e.button > 0) return;
    // 멀티터치 무시: 이미 드래그 중이거나 primary 포인터가 아니면 받지 않는다.
    if (activePointerId !== null) return;
    if (e.isPrimary === false) return;

    // 오디오 언락 제스처 확보 지점 (spec §2.2 부수효과 / §5.3 재언락).
    // disabled(=running) 상태에서도 값은 바꾸지 않지만 언락 힌트는 흘려보낸다.
    if (typeof onUnlockHint === 'function') onUnlockHint();

    if (isDisabled()) return; // spec §3.4 running 중 다이얼 조작 거부 (기준 7)

    beginDrag(e);

    let captured = false;
    try {
      if (typeof dialEl.setPointerCapture === 'function') {
        dialEl.setPointerCapture(e.pointerId);
        captured = true;
      }
    } catch {
      captured = false;
    }
    // 캡처를 못 얻으면 다이얼 밖 추적을 위해 document 폴백을 건다 (기준 3).
    if (!captured) startDocFallback();

    if (typeof e.preventDefault === 'function' && e.cancelable !== false) e.preventDefault();
  }

  function onPointerMove(e) {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (alreadyHandled(e)) return;
    if (isDisabled()) return;

    const g = geometry();
    const dx = e.clientX - g.cx;
    const dy = e.clientY - g.cy;

    // 중심 근처 각도 노이즈: 반경의 minRadiusRatio 미만이면 이동 자체를 무시한다.
    // lastAngle 도 갱신하지 않는다 — 노이즈 구간의 각도를 기준으로 삼지 않기 위함.
    if (g.radius > 0 && Math.hypot(dx, dy) < minRadiusRatio * g.radius) return;

    const a = Math.atan2(dy, dx) * DEG;
    // 언랩 누적 + [0,360] 클램프는 core/angle.js 담당 → 59→0 / 0→59 로 튀지 않는다 (기준 2).
    accum = angleToAccum(accum, lastAngle, a);
    lastAngle = a;
    moved = true;

    const minutes = snap(accumToMinutes(accum), e.shiftKey);
    lastMinutes = minutes;
    if (typeof onAngleChange === 'function') onAngleChange(minutes);
  }

  function onPointerUp(e) {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (alreadyHandled(e)) return;

    const id = activePointerId;
    endDrag();
    releaseCapture(id);

    if (isDisabled()) return;

    // 유효한 release = 최소 분 이상. 0분에서 떼면 시작할 값이 없으므로 롤백.
    if (lastMinutes >= minMinutes) {
      if (typeof onCommit === 'function') onCommit(lastMinutes);
    } else if (typeof onCancel === 'function') {
      onCancel();
    }
  }

  function onPointerCancel(e) {
    if (activePointerId === null || (e && e.pointerId !== activePointerId)) return;
    if (e && alreadyHandled(e)) return;
    const id = activePointerId;
    endDrag();
    releaseCapture(id);
    if (typeof onCancel === 'function') onCancel();
  }

  /**
   * lostpointercapture 는 정상 pointerup 뒤(우리가 release 한 직후)에도 발생한다.
   * endDrag() 로 activePointerId 가 이미 null 이므로 그때는 no-op 이고,
   * 브라우저가 캡처를 강제로 뺏은 경우에만 롤백이 돌아간다.
   */
  function onLostCapture(e) {
    if (activePointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    endDrag();
    if (typeof onCancel === 'function') onCancel();
  }

  function releaseCapture(id) {
    try {
      if (typeof dialEl.releasePointerCapture === 'function' &&
          (typeof dialEl.hasPointerCapture !== 'function' || dialEl.hasPointerCapture(id))) {
        dialEl.releasePointerCapture(id);
      }
    } catch {
      /* 캡처가 이미 풀렸으면 무시 */
    }
  }

  dialEl.addEventListener('pointerdown', onPointerDown);
  dialEl.addEventListener('pointermove', onPointerMove);
  dialEl.addEventListener('pointerup', onPointerUp);
  dialEl.addEventListener('pointercancel', onPointerCancel);
  dialEl.addEventListener('lostpointercapture', onLostCapture);

  return {
    detach() {
      if (activePointerId !== null) {
        const id = activePointerId;
        endDrag();
        releaseCapture(id);
      }
      stopDocFallback();
      dialEl.removeEventListener('pointerdown', onPointerDown);
      dialEl.removeEventListener('pointermove', onPointerMove);
      dialEl.removeEventListener('pointerup', onPointerUp);
      dialEl.removeEventListener('pointercancel', onPointerCancel);
      dialEl.removeEventListener('lostpointercapture', onLostCapture);
      dialEl.classList.remove(DRAG_CLASS);
    },
    setDisabled(v) {
      disabledFlag = v === null || v === undefined ? null : !!v;
      if (disabledFlag === true && activePointerId !== null) {
        const id = activePointerId;
        endDrag();
        releaseCapture(id);
        if (typeof onCancel === 'function') onCancel();
      }
    },
    isDragging() {
      return activePointerId !== null;
    },
  };
}
