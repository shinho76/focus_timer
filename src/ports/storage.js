/**
 * ports/storage.js — Web Storage 어댑터. spec §7.1
 *
 * 원칙
 * - `v` 불일치 → **조용히 폐기 후 null**. 마이그레이션도 예외 던지기도 하지 않는다.
 * - 접근 실패(프라이빗 모드 / 쿼터 초과 / 손상) → **메모리 폴백**으로 타이머는 계속 동작.
 * - `paused` 는 deadline 이 무의미 → `deadlineWall: null, remainingMs: <수>` 로 정규화.
 */

/** 현재 스키마 버전. 불일치 레코드는 폐기한다. */
export const SCHEMA_VERSION = 1;

/**
 * 저장 레코드.
 * @typedef {object} TimerRecord
 * @property {number} v
 * @property {'idle'|'running'|'paused'|'expired'|string} state
 * @property {'simple'|'pomodoro'|string} [mode]
 * @property {'focus'|'break'|'longbreak'|string} [phase]
 * @property {number} [totalMs]
 * @property {number|null} [deadlineWall]
 * @property {number|null} [remainingMs]
 * @property {number} [cycleIndex]
 * @property {string} [dayKey]
 * @property {number} [completedToday]
 * @property {Record<string, number>} [dailyCounts]
 * @property {object} [settings]
 * @property {number} [savedAtWall]
 */

/**
 * running 은 deadlineWall 로, paused 는 remainingMs 로만 산다.
 * 둘 다 의미 있게 채워진 레코드는 만들지 않는다(v3 초안의 내부 모순).
 * @param {any} rec
 * @returns {any}
 */
function normalize(rec) {
  const out = { ...rec };
  if (out.state === 'paused') {
    out.deadlineWall = null;
    out.remainingMs = typeof out.remainingMs === 'number' ? out.remainingMs : 0;
  } else if (out.state === 'running') {
    out.remainingMs = null;
    out.deadlineWall = typeof out.deadlineWall === 'number' ? out.deadlineWall : null;
  }
  return out;
}

/**
 * @param {Storage|null|undefined} storageImpl localStorage 등. 없거나 접근 불가면 즉시 메모리 폴백.
 * @param {string} key 최종 저장 키(네임스페이스 `focus-timer.v1:*` 조립은 호출자 책임).
 * @param {{ now?: () => number }} [opts] savedAtWall 을 채울 시계. 기본 Date.now.
 * @returns {{
 *   load(): TimerRecord|null,
 *   save(state: object): boolean,
 *   clear(): void,
 *   readonly isPersisted: boolean,
 *   onPersistenceLost(cb: () => void): void
 * }}
 */
export function createStoragePort(storageImpl, key, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** 폴백용 인메모리 백업. @type {Map<string, string>} */
  const memory = new Map();
  /** 한 번 폴백하면 세션 내내 메모리로 간다(실 스토리지와 갈라지는 걸 막는다). */
  let memoryMode = false;
  /** 마지막 쓰기가 실제 스토리지에 닿았는가. */
  let persisted = true;
  /** "기록이 저장되지 않습니다" 고지는 1회만. */
  let noticeFired = false;
  /** @type {(() => void)|null} */
  let onLost = null;

  /** 스토리지가 쓸 만한지 최소 확인. */
  function usable(s) {
    return !!s && typeof s.getItem === 'function' && typeof s.setItem === 'function';
  }

  /** 폴백 진입 — 최초 1회만 고지 콜백을 쏜다. */
  function fallback() {
    persisted = false;
    if (memoryMode) return;
    memoryMode = true;
    if (!noticeFired && onLost) {
      noticeFired = true;
      try {
        onLost();
      } catch {
        /* 고지 UI 실패가 저장 경로를 막지 않는다 */
      }
    }
  }

  if (!usable(storageImpl)) fallback();

  /** @param {string} raw */
  function parse(raw) {
    if (raw == null) return null;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      return null; // 손상 → 폐기
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    if (rec.v !== SCHEMA_VERSION) return null; // v 불일치 → 조용히 폐기, 마이그레이션 없음
    return normalize(rec);
  }

  function readRaw() {
    if (!memoryMode) {
      try {
        return storageImpl.getItem(key);
      } catch {
        fallback();
      }
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  /** @param {string} raw @returns {boolean} 실 스토리지에 닿았는지 */
  function writeRaw(raw) {
    memory.set(key, raw); // 폴백 대비 항상 메모리에도 남긴다
    if (!memoryMode) {
      try {
        storageImpl.setItem(key, raw);
        persisted = true;
        return true;
      } catch {
        fallback(); // 쿼터 초과 / 차단
      }
    }
    persisted = false;
    return false;
  }

  function removeRaw() {
    memory.delete(key);
    if (!memoryMode) {
      try {
        storageImpl.removeItem(key);
      } catch {
        fallback();
      }
    }
  }

  return {
    /**
     * @returns {TimerRecord|null} 없음·손상·버전 불일치는 전부 null(=idle 상당). 절대 던지지 않는다.
     */
    load() {
      const raw = readRaw();
      const rec = parse(raw);
      if (rec == null && raw != null) removeRaw(); // 쓸 수 없는 레코드는 치운다
      return rec;
    },

    /**
     * @param {object} state 스키마 필드들. `savedAtWall` 을 주지 않으면 채워 넣는다.
     * @returns {boolean} 실제 스토리지에 기록됐는지(=isPersisted 와 동일 값)
     */
    save(state) {
      const rec = normalize({
        ...(state || {}),
        v: SCHEMA_VERSION,
        savedAtWall:
          state && typeof state.savedAtWall === 'number' ? state.savedAtWall : now(),
      });
      let raw;
      try {
        raw = JSON.stringify(rec);
      } catch {
        return false; // 순환 참조 등 — 저장 실패지만 타이머는 계속 간다
      }
      return writeRaw(raw);
    },

    clear() {
      removeRaw();
    },

    /**
     * 마지막 쓰기가 실제 스토리지에 닿았는가. 한 번 폴백하면 세션 내내 false.
     */
    get isPersisted() {
      return persisted && !memoryMode;
    },

    /**
     * "기록이 저장되지 않습니다" 1회 고지 훅. 최초 폴백 시 정확히 한 번 호출된다.
     * 등록 시점에 이미 폴백했다면 즉시 동기 호출한다(등록 순서와 무관하게 1회 보장).
     * @param {() => void} cb
     */
    onPersistenceLost(cb) {
      if (typeof cb !== 'function') return;
      if (memoryMode) {
        if (noticeFired) return; // 이미 고지했다 — 두 번 알리지 않는다
        noticeFired = true;
        try {
          cb();
        } catch {
          /* noop */
        }
        return;
      }
      onLost = cb;
    },
  };
}
