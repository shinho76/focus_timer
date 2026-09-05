// @ts-check
import { test, expect } from '@playwright/test';

/**
 * spec-v4 §7.2/§7.3, 수용 기준 21,23,24 — 실제 2탭(같은 브라우저 컨텍스트 =
 * 같은 origin의 localStorage/BroadcastChannel 공유)에서 리더 선출과 상태
 * 미러링을 검증한다. Vitest 단위테스트는 각 모듈을 페이크로 검증했을 뿐,
 * 실제 두 개의 `<focus-timer>` 인스턴스가 진짜 BroadcastChannel 로 통신하는
 * 것은 이 스위트가 유일하게 확인한다.
 */

async function gotoFresh(page) {
  await page.goto('/demo/index.html');
  await page.evaluate(() => {
    localStorage.clear();
    // 데모 페이지가 위젯을 <dialog> 모달 안에 넣어뒀다 — 리더 선출 자체는
    // 화면 표시와 무관하게 동작하지만, 이 스위트의 다른 테스트들이 primary
    // 버튼 클릭 등 실제 상호작용도 하므로 열어둔 상태로 통일한다.
    document.getElementById('ft-modal').showModal();
  });
}

test.describe('다중 탭 (기준 21,23,24)', () => {
  test('한 탭에서 시작하면 다른 탭도 같은 잔여 시간을 보이고, 리더만 알람을 예약한다', async ({
    context,
  }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await gotoFresh(pageA);
    await pageB.goto('/demo/index.html');

    await pageA.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      ft.reset();
      ft.setMinutes(20);
      ft.start();
    });

    // 팔로워(B)가 브로드캐스트를 받아 스스로 running 으로 전이할 시간을 준다.
    await pageB.waitForFunction(
      () => document.querySelector('focus-timer').state === 'running',
      null,
      { timeout: 3000 },
    );

    const [a, b] = await Promise.all([
      pageA.evaluate(() => {
        const ft = document.querySelector('focus-timer');
        return { isLeader: ft.isLeader, remainingMs: ft.remainingMs, totalMs: ft.totalMs, hasAlarm: !!ft._alarmCancel };
      }),
      pageB.evaluate(() => {
        const ft = document.querySelector('focus-timer');
        return { isLeader: ft.isLeader, remainingMs: ft.remainingMs, totalMs: ft.totalMs, hasAlarm: !!ft._alarmCancel };
      }),
    ]);

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(a.totalMs).toBe(b.totalMs);
    // 완전히 같은 밀리초는 아닐 수 있다(브로드캐스트 사이 로컬 tick) — 2초 이내 오차 허용.
    expect(Math.abs(a.remainingMs - b.remainingMs)).toBeLessThan(2000);
    // 리더만 알람을 예약한다 — 팔로워는 오디오 포트를 건드리지 않는다.
    expect(a.hasAlarm).toBe(true);
    expect(b.hasAlarm).toBe(false);

    await pageA.close();
    await pageB.close();
  });

  test('리더 탭이 확인(acknowledge)하면 팔로워 탭도 idle 로 돌아온다', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await gotoFresh(pageA);
    await pageB.goto('/demo/index.html');

    await pageA.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      ft.reset();
      ft.setMinutes(5);
      ft.start();
      ft.extend(-5 * 60000); // 즉시 만료시켜 ringing 으로
    });

    await pageA.waitForFunction(() => document.querySelector('focus-timer').state === 'ringing');
    await pageB.waitForFunction(
      () => document.querySelector('focus-timer').state === 'ringing',
      null,
      { timeout: 3000 },
    );

    await pageA.evaluate(() => document.querySelector('focus-timer').acknowledge());

    await pageB.waitForFunction(
      () => document.querySelector('focus-timer').state === 'idle',
      null,
      { timeout: 3000 },
    );
    const bState = await pageB.evaluate(() => document.querySelector('focus-timer').state);
    expect(bState).toBe('idle');

    await pageA.close();
    await pageB.close();
  });

  test('한 탭을 닫으면 나머지 탭이 리더를 승계한다 (기준 24)', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await gotoFresh(pageA);
    await pageB.goto('/demo/index.html');

    await pageA.waitForFunction(() => document.querySelector('focus-timer').isLeader === true);
    const bBefore = await pageB.evaluate(() => document.querySelector('focus-timer').isLeader);
    expect(bBefore).toBe(false);

    await pageA.close(); // beforeunload/pagehide 없이 컨텍스트를 직접 닫음 — destroy() 는 안 불릴 수 있다

    // Web Locks 는 탭이 죽으면(프로세스 종료) 브라우저가 자동으로 락을 해제한다.
    await pageB.waitForFunction(() => document.querySelector('focus-timer').isLeader === true, null, {
      timeout: 5000,
    });

    await pageB.close();
  });
});

test.describe('타이틀 소유권 (기준 23)', () => {
  test('destroy() 후 document.title 이 정확히 원래 값으로 복원된다', async ({ page }) => {
    await gotoFresh(page);
    const original = await page.title();

    await page.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      ft.setMinutes(10);
      ft.start();
    });
    await page.waitForFunction((orig) => document.title !== orig, original);

    await page.evaluate(() => document.querySelector('focus-timer').destroy());
    const restored = await page.title();
    expect(restored).toBe(original);
  });
});
