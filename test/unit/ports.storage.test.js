import { describe, it, expect } from 'vitest';
import { createStoragePort, SCHEMA_VERSION } from '../../src/ports/storage.js';
import { createMemStorage } from '../fakes/memStorage.js';

const KEY = 'focus-timer.v1:default';

/** spec §7.1 의 샘플 레코드 (v/savedAtWall 은 포트가 채운다). */
const RUNNING = {
  state: 'running',
  mode: 'simple',
  phase: 'focus',
  totalMs: 3000000,
  deadlineWall: 1757000000000,
  remainingMs: null,
  cycleIndex: 1,
  dayKey: '2026-09-04',
  completedToday: 3,
  dailyCounts: { '2026-09-03': 8 },
  settings: { volume: 0.35, alarmLength: 30 },
};

describe('ports/storage — 스키마 (spec §7.1)', () => {
  it('save→load 왕복에서 스키마 필드가 보존된다', () => {
    const s = createMemStorage();
    const port = createStoragePort(s, KEY, { now: () => 1756999100000 });

    expect(port.save(RUNNING)).toBe(true);
    const rec = port.load();
    expect(rec).toMatchObject({
      v: SCHEMA_VERSION,
      state: 'running',
      mode: 'simple',
      phase: 'focus',
      totalMs: 3000000,
      deadlineWall: 1757000000000,
      remainingMs: null,
      cycleIndex: 1,
      dayKey: '2026-09-04',
      completedToday: 3,
      dailyCounts: { '2026-09-03': 8 },
      savedAtWall: 1756999100000,
    });
  });

  it('주어진 키에 정확히 쓴다 (네임스페이스 조립은 호출자 몫)', () => {
    const s = createMemStorage();
    createStoragePort(s, KEY).save(RUNNING);
    expect(s.getItem(KEY)).toBeTypeOf('string');
    expect(s.getItem('other')).toBeNull();
  });

  it('paused 는 deadlineWall: null + remainingMs: <수> 로 정규화된다', () => {
    const s = createMemStorage();
    const port = createStoragePort(s, KEY);
    port.save({ ...RUNNING, state: 'paused', deadlineWall: 1757000000000, remainingMs: 1200000 });

    const raw = JSON.parse(s.getItem(KEY));
    expect(raw.deadlineWall).toBeNull();
    expect(raw.remainingMs).toBe(1200000);
    expect(port.load()).toMatchObject({ state: 'paused', deadlineWall: null, remainingMs: 1200000 });
  });

  it('running 은 remainingMs 를 null 로 정규화한다 (둘 다 의미 있게 채우지 않는다)', () => {
    const s = createMemStorage();
    const port = createStoragePort(s, KEY);
    port.save({ ...RUNNING, state: 'running', remainingMs: 999999 });
    expect(JSON.parse(s.getItem(KEY)).remainingMs).toBeNull();
  });

  it('savedAtWall 을 호출자가 주면 그 값을 쓴다', () => {
    const s = createMemStorage();
    createStoragePort(s, KEY, { now: () => 1 }).save({ ...RUNNING, savedAtWall: 42 });
    expect(JSON.parse(s.getItem(KEY)).savedAtWall).toBe(42);
  });

  it('빈 스토리지 load 는 null', () => {
    expect(createStoragePort(createMemStorage(), KEY).load()).toBeNull();
  });

  it('clear() 후 load 는 null', () => {
    const s = createMemStorage();
    const port = createStoragePort(s, KEY);
    port.save(RUNNING);
    port.clear();
    expect(s.getItem(KEY)).toBeNull();
    expect(port.load()).toBeNull();
  });
});

describe('ports/storage — v 불일치·손상 (수용 기준 20)', () => {
  it('v 가 다르면 조용히 폐기하고 null (마이그레이션 없음, 예외 없음)', () => {
    const s = createMemStorage();
    s.setItem(KEY, JSON.stringify({ ...RUNNING, v: 2, totalMs: 123 }));
    const port = createStoragePort(s, KEY);

    expect(() => port.load()).not.toThrow();
    expect(port.load()).toBeNull();
    expect(s.getItem(KEY)).toBeNull(); // 못 쓰는 레코드는 치운다
  });

  it('v 가 없어도 폐기', () => {
    const s = createMemStorage();
    s.setItem(KEY, JSON.stringify({ state: 'running' }));
    expect(createStoragePort(s, KEY).load()).toBeNull();
  });

  it('손상된 JSON 은 던지지 않고 null', () => {
    const s = createMemStorage();
    s.setItem(KEY, '{"v":1,"state":"run');
    const port = createStoragePort(s, KEY);
    expect(() => port.load()).not.toThrow();
    expect(port.load()).toBeNull();
  });

  it('객체가 아닌 JSON 도 폐기', () => {
    const s = createMemStorage();
    s.setItem(KEY, '[1,2,3]');
    expect(createStoragePort(s, KEY).load()).toBeNull();
  });
});

describe('ports/storage — 메모리 폴백 (수용 기준 20)', () => {
  it('쓰기 실패 시 폴백하고 isPersisted 가 false 가 된다', () => {
    const s = createMemStorage({ throwOnWrite: true });
    const port = createStoragePort(s, KEY);

    expect(port.isPersisted).toBe(true); // 아직 실패 전
    expect(() => port.save(RUNNING)).not.toThrow();
    expect(port.save(RUNNING)).toBe(false);
    expect(port.isPersisted).toBe(false);
  });

  it('폴백 후에도 save/load 가 정상 동작한다 (타이머는 계속 간다)', () => {
    const s = createMemStorage({ throwOnWrite: true });
    const port = createStoragePort(s, KEY);
    port.save({ ...RUNNING, state: 'paused', remainingMs: 60000 });

    expect(s.size).toBe(0); // 실제 스토리지에는 아무것도 없다
    expect(port.load()).toMatchObject({ state: 'paused', remainingMs: 60000, deadlineWall: null });
  });

  it('한 번 폴백하면 세션 내내 메모리 모드 (실 스토리지와 갈라지지 않는다)', () => {
    const s = createMemStorage({ throwOnWrite: true });
    const port = createStoragePort(s, KEY);
    port.save(RUNNING);
    s.throwOnWrite = false; // 쿼터가 풀려도

    expect(port.save({ ...RUNNING, totalMs: 60000 })).toBe(false);
    expect(port.isPersisted).toBe(false);
    expect(s.size).toBe(0);
    expect(port.load()).toMatchObject({ totalMs: 60000 });
  });

  it('스토리지가 아예 없어도(프라이빗 모드) 동작하고 isPersisted 는 false', () => {
    const port = createStoragePort(null, KEY);
    expect(port.isPersisted).toBe(false);
    expect(port.save(RUNNING)).toBe(false);
    expect(port.load()).toMatchObject({ state: 'running', v: SCHEMA_VERSION });
  });

  it('읽기가 던져도 폴백하고 null (손상/차단)', () => {
    const s = createMemStorage();
    s.getItem = () => {
      throw new DOMException('SecurityError');
    };
    const port = createStoragePort(s, KEY);
    expect(() => port.load()).not.toThrow();
    expect(port.load()).toBeNull();
    expect(port.isPersisted).toBe(false);
  });
});

describe('ports/storage — "기록이 저장되지 않습니다" 1회 고지', () => {
  it('최초 폴백에서 정확히 한 번만 호출된다', () => {
    const s = createMemStorage({ throwOnWrite: true });
    const port = createStoragePort(s, KEY);
    let notices = 0;
    port.onPersistenceLost(() => {
      notices++;
    });

    expect(notices).toBe(0);
    port.save(RUNNING);
    expect(notices).toBe(1);
    port.save(RUNNING);
    port.save(RUNNING);
    expect(notices).toBe(1);
  });

  it('정상 스토리지에서는 호출되지 않는다', () => {
    const port = createStoragePort(createMemStorage(), KEY);
    let notices = 0;
    port.onPersistenceLost(() => {
      notices++;
    });
    port.save(RUNNING);
    expect(notices).toBe(0);
    expect(port.isPersisted).toBe(true);
  });

  it('이미 폴백한 뒤에 등록해도 즉시 1회 호출된다 (등록 순서 무관)', () => {
    const port = createStoragePort(null, KEY);
    let notices = 0;
    port.onPersistenceLost(() => {
      notices++;
    });
    expect(notices).toBe(1);

    // 같은 세션에서 두 번째 등록자에게는 다시 고지하지 않는다.
    port.onPersistenceLost(() => {
      notices++;
    });
    expect(notices).toBe(1);
  });

  it('고지 콜백이 던져도 save 는 실패하지 않는다', () => {
    const s = createMemStorage({ throwOnWrite: true });
    const port = createStoragePort(s, KEY);
    port.onPersistenceLost(() => {
      throw new Error('UI 폭발');
    });
    expect(() => port.save(RUNNING)).not.toThrow();
    expect(port.load()).toMatchObject({ state: 'running' });
  });
});
