import { describe, it, expect } from 'vitest';
import { createNotifierPort } from '../../src/ports/notifier.js';
import { createSpyNotifier } from '../fakes/spyNotifier.js';

/** requestPermission 호출 횟수를 세는 스파이 (재프롬프트 루프 검증용). */
function countingNotifier(opts, answer) {
  const Ctor = createSpyNotifier(opts);
  const calls = { requestPermission: 0 };
  Ctor.requestPermission = async () => {
    calls.requestPermission++;
    if (answer) Ctor.permission = answer;
    return Ctor.permission;
  };
  return { Ctor, calls };
}

function fakeWindow() {
  const win = { focused: 0, focus: () => { win.focused++; } };
  return win;
}

describe('ports/notifier — 권한 (수용 기준 28)', () => {
  it('permission 게터가 현재 상태를 반영한다', () => {
    for (const p of ['default', 'granted', 'denied']) {
      const port = createNotifierPort(createSpyNotifier({ permission: p }));
      expect(port.permission).toBe(p);
    }
  });

  it('거부 상태면 실제 API 를 부르지 않고 단락한다 (재요청 루프 0)', async () => {
    const { Ctor, calls } = countingNotifier({ permission: 'denied' });
    const port = createNotifierPort(Ctor);

    await expect(port.requestPermission()).resolves.toBe('denied');
    await expect(port.requestPermission()).resolves.toBe('denied');
    await expect(port.requestPermission()).resolves.toBe('denied');
    expect(calls.requestPermission).toBe(0);
  });

  it('한 번 거부당한 결과를 기억하고 다시 묻지 않는다', async () => {
    const { Ctor, calls } = countingNotifier({ permission: 'default' }, 'denied');
    const port = createNotifierPort(Ctor);

    await expect(port.requestPermission()).resolves.toBe('denied');
    expect(calls.requestPermission).toBe(1);

    await expect(port.requestPermission()).resolves.toBe('denied');
    await expect(port.requestPermission()).resolves.toBe('denied');
    expect(calls.requestPermission).toBe(1);
    expect(port.permission).toBe('denied');
  });

  it('허용되면 granted 를 돌려주고 이후 재요청도 API 를 부르지 않는다', async () => {
    const { Ctor, calls } = countingNotifier({ permission: 'default' }, 'granted');
    const port = createNotifierPort(Ctor);

    await expect(port.requestPermission()).resolves.toBe('granted');
    await expect(port.requestPermission()).resolves.toBe('granted');
    expect(calls.requestPermission).toBe(1);
    expect(port.permission).toBe('granted');
  });

  it('requestPermission 이 던져도 전파하지 않는다', async () => {
    const Ctor = createSpyNotifier({ permission: 'default' });
    Ctor.requestPermission = () => {
      throw new TypeError('not supported');
    };
    const port = createNotifierPort(Ctor);
    await expect(port.requestPermission()).resolves.toBe('default');
  });

  it('콜백형(구형 Safari) requestPermission 도 받는다', async () => {
    const Ctor = createSpyNotifier({ permission: 'default' });
    Ctor.requestPermission = (cb) => {
      Ctor.permission = 'granted';
      cb('granted');
    };
    const port = createNotifierPort(Ctor);
    await expect(port.requestPermission()).resolves.toBe('granted');
  });

  it('Notification 자체가 없으면(iOS Safari 비 PWA) unsupported', async () => {
    const port = createNotifierPort(undefined);
    expect(port.permission).toBe('unsupported');
    await expect(port.requestPermission()).resolves.toBe('unsupported');
    expect(port.show('끝났습니다')).toBeNull();
  });
});

describe('ports/notifier — show 는 절대 던지지 않는다 (spec §5.4)', () => {
  it('허용 상태에서 알림을 띄운다', () => {
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const port = createNotifierPort(Ctor);

    const n = port.show('50분 완료', { body: '휴식 시작', tag: 'ft' });
    expect(n).not.toBeNull();
    expect(Ctor._shown).toHaveLength(1);
    expect(Ctor._shown[0]).toEqual({ title: '50분 완료', opts: { body: '휴식 시작', tag: 'ft' } });
  });

  it('Android Chrome 처럼 생성자가 던지면 삼키고 null (인페이지 배너 폴백용)', () => {
    const Ctor = createSpyNotifier({ permission: 'granted', throwOnConstruct: true });
    const port = createNotifierPort(Ctor);

    let result;
    expect(() => {
      result = port.show('50분 완료');
    }).not.toThrow();
    expect(result).toBeNull();
    expect(Ctor._shown).toHaveLength(0);
  });

  it('권한이 없으면 생성 자체를 시도하지 않고 null', () => {
    for (const p of ['default', 'denied']) {
      const Ctor = createSpyNotifier({ permission: p });
      const port = createNotifierPort(Ctor);
      expect(port.show('50분 완료')).toBeNull();
      expect(Ctor._shown).toHaveLength(0);
    }
  });

  it('포트 전용 옵션(windowRef/onClick)은 Notification 에 넘기지 않는다', () => {
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const port = createNotifierPort(Ctor);
    port.show('제목', { body: 'b', windowRef: fakeWindow(), onClick: () => {} });
    expect(Ctor._shown[0].opts).toEqual({ body: 'b' });
  });
});

describe('ports/notifier — 클릭 시 window.focus() (spec §5.5)', () => {
  it('생성자 2번째 인자로 받은 window 를 포커스한다', () => {
    const win = fakeWindow();
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const n = createNotifierPort(Ctor, win).show('완료');

    expect(typeof n.onclick).toBe('function');
    n.onclick();
    expect(win.focused).toBe(1);
  });

  it('opts.windowRef 가 생성자 인자보다 우선한다', () => {
    const ctorWin = fakeWindow();
    const callWin = fakeWindow();
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const n = createNotifierPort(Ctor, ctorWin).show('완료', { windowRef: callWin });

    n.onclick();
    expect(callWin.focused).toBe(1);
    expect(ctorWin.focused).toBe(0);
  });

  it('opts.onClick 도 함께 호출된다', () => {
    const win = fakeWindow();
    let clicked = 0;
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const n = createNotifierPort(Ctor, win).show('완료', { onClick: () => { clicked++; } });

    n.onclick();
    expect(clicked).toBe(1);
    expect(win.focused).toBe(1);
  });

  it('window 가 없어도 클릭 핸들러가 던지지 않는다', () => {
    const Ctor = createSpyNotifier({ permission: 'granted' });
    const n = createNotifierPort(Ctor).show('완료');
    expect(() => n.onclick()).not.toThrow();
  });
});
