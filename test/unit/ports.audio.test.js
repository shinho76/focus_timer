import { describe, it, expect } from 'vitest';
import { createAudioPort } from '../../src/ports/audio.js';
import { createSpyAudioContext } from '../fakes/spyAudio.js';

/**
 * 스파이 컨텍스트를 만들고, 생성된 GainNode 들도 함께 수집할 수 있게 감싼다.
 * (spyAudio 는 오실레이터만 `_oscillators` 로 노출한다.)
 */
function setup({ startTime = 0 } = {}) {
  const ctx = createSpyAudioContext({ startTime });
  const gains = [];
  const createGain = ctx.createGain;
  ctx.createGain = () => {
    const g = createGain();
    gains.push(g);
    return g;
  };
  // `new Ctor()` 이 객체를 반환하면 그 객체가 인스턴스가 된다.
  const Ctor = function FakeAudioContext() {
    return ctx;
  };
  return { ctx, gains, port: createAudioPort(Ctor) };
}

describe('ports/audio — scheduleAlarm (수용 기준 25)', () => {
  it('alarm-length 3 → 1초 간격 비프 3회', () => {
    const { ctx, port } = setup({ startTime: 0 });
    port.scheduleAlarm(5000, 0.8, 3);

    const oscs = ctx._oscillators;
    expect(oscs).toHaveLength(3);
    expect(oscs.map((o) => o.started)).toEqual([5, 6, 7]);
  });

  it('alarm-length 30 → 비프 30회, 마지막 비프는 t0+29초', () => {
    const { ctx, port } = setup({ startTime: 0 });
    port.scheduleAlarm(0, 0.8, 30);

    const oscs = ctx._oscillators;
    expect(oscs).toHaveLength(30);
    expect(oscs[0].started).toBeCloseTo(0, 6);
    expect(oscs[29].started).toBeCloseTo(29, 6);
    // 간격은 정확히 1초 (실측 오차 ≤ 0.3초 요건의 상한을 만족)
    for (let i = 1; i < oscs.length; i++) {
      expect(oscs[i].started - oscs[i - 1].started).toBeCloseTo(1, 6);
    }
  });

  it('JS 타이머가 아니라 오디오 클럭(currentTime + remainingMs/1000)에 예약한다', () => {
    const { ctx, port } = setup({ startTime: 12.5 });
    port.scheduleAlarm(3000, 0.35, 3);
    expect(ctx._oscillators[0].started).toBeCloseTo(15.5, 6);
  });

  it('각 비프는 880Hz, 시작 +0.4초에 정지 예약', () => {
    const { ctx, port } = setup();
    port.scheduleAlarm(1000, 0.35, 3);
    for (const o of ctx._oscillators) {
      expect(o.frequency.value).toBe(880);
      expect(o.stopped).toBeCloseTo(o.started + 0.4, 6);
    }
  });

  it('음량 3단계가 게인 엔벨로프 피크로 구분된다 (0.35 vs 0.8)', () => {
    const soft = setup();
    soft.port.scheduleAlarm(0, 0.35, 3);
    const loud = setup();
    loud.port.scheduleAlarm(0, 0.8, 3);

    const peak = (g) => Math.max(...g.gain.events.map((e) => e.v));
    expect(soft.gains.map(peak)).toEqual([0.35, 0.35, 0.35]);
    expect(loud.gains.map(peak)).toEqual([0.8, 0.8, 0.8]);
  });

  it('엔벨로프 모양은 spec §5.2 그대로 (set 0 → linear volume @+0.02 → exp @+0.35)', () => {
    const { gains, port } = setup({ startTime: 2 });
    port.scheduleAlarm(0, 0.8, 1);
    const [g] = gains;
    const [e0, e1, e2] = g.gain.events;
    expect(g.gain.events).toHaveLength(3);
    expect(e0).toMatchObject({ type: 'set', v: 0 });
    expect(e0.t).toBeCloseTo(2, 6);
    expect(e1).toMatchObject({ type: 'linear', v: 0.8 });
    expect(e1.t).toBeCloseTo(2.02, 6);
    expect(e2).toMatchObject({ type: 'exp', v: 0.0001 });
    expect(e2.t).toBeCloseTo(2.35, 6);
  });
});

describe('ports/audio — 무음 (수용 기준 26)', () => {
  it('volume 0 이면 게인 값이 시종일관 0 (피크 0)', () => {
    const { gains, port } = setup();
    port.scheduleAlarm(1000, 0, 3);

    expect(gains).toHaveLength(3);
    for (const g of gains) {
      expect(g.gain.value).toBe(0);
      expect(g.gain.events.length).toBeGreaterThan(0);
      for (const e of g.gain.events) expect(e.v).toBe(0);
      // 0.0001 로 수렴하는 지수 램프는 "아주 작은 소리"지 무음이 아니다.
      expect(g.gain.events.some((e) => e.type === 'exp')).toBe(false);
    }
  });

  it('volume 0 에서도 미리 듣기는 무음', () => {
    const { gains, port } = setup();
    port.previewAlarm(0);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.events.every((e) => e.v === 0)).toBe(true);
  });
});

describe('ports/audio — cancelAll (유령 알람 방지)', () => {
  it('예약된 모든 오실레이터에 stop() 을 건다', () => {
    const { ctx, port } = setup();
    port.scheduleAlarm(60000, 0.8, 30);
    expect(ctx._oscillators.every((o) => o.stoppedEarly)).toBe(false);

    port.cancelAll();
    expect(ctx._oscillators).toHaveLength(30);
    expect(ctx._oscillators.every((o) => o.stoppedEarly)).toBe(true);
  });

  it('취소 후 pending 목록이 비어 두 번째 cancelAll 은 아무것도 건드리지 않는다', () => {
    const { ctx, port } = setup();
    port.scheduleAlarm(1000, 0.8, 3);
    port.cancelAll();

    let extraStops = 0;
    for (const o of ctx._oscillators) o.stop = () => { extraStops++; };
    port.cancelAll();
    expect(extraStops).toBe(0);
  });

  it('여러 번 예약해도 전부 취소된다 (pause→start→pause 반복)', () => {
    const { ctx, port } = setup();
    port.scheduleAlarm(1000, 0.8, 3);
    port.scheduleAlarm(2000, 0.8, 3);
    port.previewAlarm(0.8);
    port.cancelAll();
    expect(ctx._oscillators).toHaveLength(7);
    expect(ctx._oscillators.every((o) => o.stoppedEarly)).toBe(true);
  });

  it('scheduleAlarm 이 돌려준 취소 함수는 그 묶음만 취소한다', () => {
    const { ctx, port } = setup();
    const cancelFirst = port.scheduleAlarm(1000, 0.8, 3);
    port.scheduleAlarm(2000, 0.8, 3);

    cancelFirst();
    const [a, b, c, d, e, f] = ctx._oscillators;
    expect([a, b, c].every((o) => o.stoppedEarly)).toBe(true);
    expect([d, e, f].some((o) => o.stoppedEarly)).toBe(false);

    // 이미 취소된 묶음은 cancelAll 에서 다시 호출되지 않는다.
    let extraStops = 0;
    for (const o of [a, b, c]) o.stop = () => { extraStops++; };
    port.cancelAll();
    expect(extraStops).toBe(0);
    expect([d, e, f].every((o) => o.stoppedEarly)).toBe(true);
  });
});

describe('ports/audio — unlock / 견고성', () => {
  it('unlock() 은 ctx.resume() 을 호출하고 true 로 resolve 한다', async () => {
    const { ctx, port } = setup();
    let resumeCalls = 0;
    ctx.resume = async () => {
      resumeCalls++;
    };
    await expect(port.unlock()).resolves.toBe(true);
    expect(resumeCalls).toBe(1);
  });

  it('resume() 이 거부돼도 던지지 않고 false 로 resolve', async () => {
    const { ctx, port } = setup();
    ctx.resume = () => Promise.reject(new Error('not allowed'));
    await expect(port.unlock()).resolves.toBe(false);
  });

  it('AudioContext 자체가 없어도 모든 호출이 안전한 no-op', async () => {
    const port = createAudioPort(undefined);
    await expect(port.unlock()).resolves.toBe(false);
    expect(() => port.scheduleAlarm(1000, 0.8, 3)()).not.toThrow();
    expect(() => port.previewAlarm(0.8)()).not.toThrow();
    expect(() => port.cancelAll()).not.toThrow();
  });

  it('previewAlarm 은 지금 즉시 비프 1회', () => {
    const { ctx, port } = setup({ startTime: 4 });
    port.previewAlarm(0.35);
    expect(ctx._oscillators).toHaveLength(1);
    expect(ctx._oscillators[0].started).toBeCloseTo(4, 6);
  });
});
