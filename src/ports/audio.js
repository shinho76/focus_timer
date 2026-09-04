/**
 * ports/audio.js — Web Audio 어댑터.
 *
 * spec §5.2: 만료 시각을 **오디오 클럭에 미리 예약**한다. JS 타이머로 울리면
 * 백그라운드 스로틀링에 그대로 당하므로, 비프 하나하나를 오디오 그래프의
 * 시간축(`ctx.currentTime`) 위에 미리 얹어 둔다.
 *
 * 외부 오디오 라이브러리·오디오 파일 없음(네트워크 요청 0건). 오실레이터 + 게인
 * 엔벨로프만 사용한다.
 */

/** 비프 주파수 (Hz). */
const BEEP_HZ = 880;
/** 어택: 0 → volume 까지 걸리는 시간 (초). */
const ATTACK_SEC = 0.02;
/** 디케이: volume → 무음 수준까지 (초). */
const DECAY_SEC = 0.35;
/** 오실레이터 정지 시각 (초, 비프 시작 기준). */
const STOP_SEC = 0.4;
/** exponentialRamp 는 0 을 타깃으로 잡을 수 없어 쓰는 실질적 무음 값. */
const SILENCE_FLOOR = 0.0001;
/** 비프 간격 (초). alarm-length 초당 1회. */
const BEEP_INTERVAL_SEC = 1;

/**
 * 비프 1회를 오디오 클럭 시각 `t` 에 예약한다.
 *
 * volume 이 0 이면(=무음 스위치) 엔벨로프 전체를 literal 0 으로 깐다.
 * `exponentialRampToValueAtTime(0.0001, ...)` 을 그대로 쓰면 피크가 0 이 아니게 되고
 * (수용 기준 26 위반) 애초에 값 0 에서 출발하는 지수 램프는 Web Audio 에서 정의되지 않는다.
 *
 * @param {AudioContext} ctx
 * @param {number} t 오디오 클럭 절대 시각(초)
 * @param {number} volume 0 | 0.35 | 0.8
 * @returns {() => void} 이 비프를 즉시 취소하는 함수
 */
function scheduleBeep(ctx, t, volume) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = BEEP_HZ;
  // 자동화 이전 구간까지 확실히 무음으로 둔다.
  g.gain.value = 0;
  if (volume > 0) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + ATTACK_SEC);
    g.gain.exponentialRampToValueAtTime(SILENCE_FLOOR, t + DECAY_SEC);
  } else {
    // 무음: 피크 진폭 정확히 0.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0, t + ATTACK_SEC);
    g.gain.linearRampToValueAtTime(0, t + DECAY_SEC);
  }
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + STOP_SEC);
  return () => {
    try {
      osc.stop();
    } catch {
      /* 이미 끝난 노드의 stop() 은 던질 수 있다 — 무시 */
    }
  };
}

/**
 * @param {typeof AudioContext} [AudioContextCtor] 없으면(=Web Audio 미지원) 전부 안전 no-op.
 * @returns {{
 *   unlock(): Promise<boolean>,
 *   scheduleAlarm(remainingMs: number, volume: number, lengthSec: number): () => void,
 *   previewAlarm(volume: number): () => void,
 *   cancelAll(): void
 * }}
 */
export function createAudioPort(AudioContextCtor) {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** 예약되어 아직 취소되지 않은 알람들의 취소 함수. @type {Set<() => void>} */
  const pending = new Set();

  const noop = () => {};

  /** 제스처 시점까지 컨텍스트 생성을 미룬다(autoplay 정책). */
  function getCtx() {
    if (ctx) return ctx;
    if (!AudioContextCtor) return null;
    try {
      ctx = new AudioContextCtor();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  /**
   * 비프 묶음 하나를 예약하고, 묶음 단위 취소 함수를 pending 에 등록한다.
   * @param {number} t0 첫 비프의 오디오 클럭 절대 시각(초)
   * @param {number} count 비프 개수
   * @param {number} volume
   * @returns {() => void}
   */
  function scheduleBatch(t0, count, volume) {
    const c = getCtx();
    if (!c || count <= 0) return noop;
    /** @type {Array<() => void>} */
    const stops = [];
    for (let i = 0; i < count; i++) {
      stops.push(scheduleBeep(c, t0 + i * BEEP_INTERVAL_SEC, volume));
    }
    const cancel = () => {
      pending.delete(cancel);
      stops.forEach((f) => f());
      stops.length = 0;
    };
    pending.add(cancel);
    return cancel;
  }

  return {
    /**
     * 사용자 제스처(포인터다운) 시점에 호출. suspended 컨텍스트를 살린다. spec §5.3
     * @returns {Promise<boolean>} 재개 성공 여부. 절대 reject 하지 않는다.
     */
    unlock() {
      const c = getCtx();
      if (!c || typeof c.resume !== 'function') return Promise.resolve(false);
      try {
        return Promise.resolve(c.resume()).then(
          () => true,
          () => false,
        );
      } catch {
        return Promise.resolve(false);
      }
    },

    /**
     * 만료 시점의 알람을 오디오 클럭에 미리 예약한다.
     * @param {number} remainingMs 지금부터 만료까지 남은 시간(ms)
     * @param {number} volume 0 | 0.35 | 0.8
     * @param {number} lengthSec 3 | 30 (초당 1비프)
     * @returns {() => void} 이 알람만 취소하는 함수 (cancelAll 도 함께 호출한다)
     */
    scheduleAlarm(remainingMs, volume, lengthSec) {
      const c = getCtx();
      if (!c) return noop;
      const delaySec = Math.max(0, Number(remainingMs) || 0) / 1000;
      const count = Math.max(0, Math.floor(Number(lengthSec) || 0));
      return scheduleBatch(c.currentTime + delaySec, count, Number(volume) || 0);
    },

    /**
     * "알람 소리 미리 듣기" — 비프 1회를 즉시. spec §5.5
     * @param {number} volume
     * @returns {() => void}
     */
    previewAlarm(volume) {
      const c = getCtx();
      if (!c) return noop;
      return scheduleBatch(c.currentTime, 1, Number(volume) || 0);
    },

    /**
     * 예약된 모든 알람을 취소한다. pause / reset / 알람 확인(ack) / visibilitychange 시
     * 반드시 호출 — 유령 알람은 결함이다. spec §5.2, §5.5
     */
    cancelAll() {
      // 취소 함수가 pending 에서 스스로를 지우므로 복사본을 돈다.
      const all = Array.from(pending);
      pending.clear();
      all.forEach((f) => {
        try {
          f();
        } catch {
          /* 개별 실패가 나머지 취소를 막지 않는다 */
        }
      });
    },
  };
}
