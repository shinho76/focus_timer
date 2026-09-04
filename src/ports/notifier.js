/**
 * ports/notifier.js — Notification 어댑터. spec §5.4 / §5.5
 *
 * 플랫폼 현실을 코드로 인정한다.
 * - Android Chrome: `new Notification()` 은 **던진다**. 모든 생성 호출을 try/catch 로 감싸고
 *   실패하면 null 을 돌려 호출자가 인페이지 배너로 폴백하게 한다.
 * - iOS Safari(비 PWA): `window.Notification` 자체가 없다 → `permission === 'unsupported'`.
 * - 거부 상태는 기억하고 **다시 묻지 않는다**(재요청 루프 0, 수용 기준 28).
 */

/** 권한 API 자체가 없을 때의 값. 'denied' 와 구분해야 UI 문구가 달라진다. */
const UNSUPPORTED = 'unsupported';

/**
 * @param {typeof Notification} [NotificationCtor] 없으면 전부 안전 no-op.
 * @param {Window|{focus?: () => void}} [windowRef] 알림 클릭 시 focus() 를 부를 대상.
 *   `show()` 의 `opts.windowRef` 로 호출별 덮어쓸 수 있다.
 * @returns {{
 *   requestPermission(): Promise<'default'|'granted'|'denied'|'unsupported'>,
 *   show(title: string, opts?: object): (Notification|null),
 *   readonly permission: 'default'|'granted'|'denied'|'unsupported'
 * }}
 */
export function createNotifierPort(NotificationCtor, windowRef) {
  /** 한 번 거부당하면 세션 내내 기억한다. */
  let denied = false;

  function current() {
    if (!NotificationCtor) return UNSUPPORTED;
    if (denied) return 'denied';
    let p;
    try {
      p = NotificationCtor.permission;
    } catch {
      return UNSUPPORTED;
    }
    if (p === 'denied') denied = true;
    return p === 'granted' || p === 'denied' || p === 'default' ? p : UNSUPPORTED;
  }

  return {
    /**
     * 설정의 명시적 "알림 켜기" 토글에서만 호출할 것(spec §5.5).
     * 이미 denied / granted 면 실제 API 를 부르지 않고 단락한다 — 재프롬프트 0.
     * 절대 reject 하지 않는다.
     */
    requestPermission() {
      const p = current();
      if (p === UNSUPPORTED || p === 'denied' || p === 'granted') {
        return Promise.resolve(p);
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          if (result === 'denied') denied = true;
          resolve(result === 'granted' || result === 'denied' || result === 'default'
            ? result
            : current());
        };
        try {
          // 구형 Safari 는 콜백형, 그 외는 Promise 형 — 둘 다 받는다.
          const ret = NotificationCtor.requestPermission(done);
          if (ret && typeof ret.then === 'function') {
            ret.then(done, () => done(current()));
          }
        } catch {
          done(current());
        }
      });
    },

    /**
     * @param {string} title
     * @param {object} [opts] Notification 옵션 + 포트 전용 필드
     *   - `opts.windowRef`: 이 호출에만 쓸 focus 대상 (생성자 2번째 인자보다 우선)
     *   - `opts.onClick`: 클릭 시 focus() 이후 추가로 부를 콜백
     *   두 필드는 Notification 에 전달하지 않고 제거한다.
     * @returns {Notification|null} 실패(미지원/미허가/생성자 throw)면 null.
     *   호출자는 null 을 보고 인페이지 배너로 폴백한다. **절대 던지지 않는다.**
     */
    show(title, opts) {
      if (!NotificationCtor) return null;
      if (current() !== 'granted') return null;

      const { windowRef: perCallWin, onClick, ...nativeOpts } = opts || {};
      const win = perCallWin || windowRef;

      let n = null;
      try {
        n = new NotificationCtor(title, nativeOpts);
      } catch {
        // Android Chrome 의 `new Notification()` 등 — 삼키고 폴백에 맡긴다.
        return null;
      }

      // 알림 클릭 → window.focus() (spec §5.5)
      try {
        n.onclick = () => {
          try {
            if (win && typeof win.focus === 'function') win.focus();
          } catch {
            /* noop */
          }
          try {
            if (typeof n.close === 'function') n.close();
          } catch {
            /* noop */
          }
          try {
            if (typeof onClick === 'function') onClick();
          } catch {
            /* noop */
          }
        };
      } catch {
        /* onclick 을 못 붙여도 알림 자체는 유효하다 */
      }
      return n;
    },

    /** 'default' | 'granted' | 'denied' | 'unsupported' */
    get permission() {
      return current();
    },
  };
}
