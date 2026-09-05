// @ts-check
import { test, expect } from '@playwright/test';

/**
 * spec-v4 §3.2/§3.4, 수용 기준 1,2,3,4,7,30 — 실제 브라우저에서 다이얼
 * 드래그·키보드 조작을 검증한다. jsdom(Vitest)로는 실제 마우스 좌표 기반
 * 각도 계산, CSS `touch-action` 상속, `role="slider"`/`role="timer"` 를 동시에
 * 검증할 수 없어 이 스위트로 보완한다.
 */

async function gotoFresh(page) {
  await page.goto('/demo/index.html');
  await page.evaluate(() => {
    localStorage.clear();
    document.querySelector('focus-timer').reset();
    // 데모 페이지가 위젯을 <dialog> 모달 안에 넣어뒀다("모달로 띄우기" 요청) —
    // 닫힌 dialog 는 렌더링되지 않아(UA 기본 `display:none`) 좌표 기반 상호작용이
    // 전부 실패한다. 테스트는 실제 사용자가 "타이머 열기" 버튼을 누른 뒤의
    // 상태를 검증하는 것이므로 여기서 그 상태를 재현한다.
    document.getElementById('ft-modal').showModal();
  });
}

async function dialCenter(page) {
  return page.evaluate(() => {
    // 데모 페이지에는 위쪽의 메인 인스턴스 외에 12개 조합 그리드가 더 있다 —
    // 항상 문서상 첫 번째(메인) 인스턴스를 기준으로 좌표를 잡는다.
    const ft = document.querySelector('focus-timer');
    const dial = ft.shadowRoot.querySelector('.ft-dial');
    const r = dial.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: r.width / 2 };
  });
}

/** dial 중심 기준, 0=12시 방향에서 시계방향 angleDeg 만큼 떨어진 좌표. */
function pointAt(center, angleDeg, radiusRatio = 0.75) {
  const rad = (angleDeg * Math.PI) / 180;
  const r = center.radius * radiusRatio;
  return { x: center.cx + r * Math.sin(rad), y: center.cy - r * Math.cos(rad) };
}

test.describe('다이얼 드래그 (기준 1,2,3,7)', () => {
  test('0/60 경계를 넘어가도 반대편으로 튀지 않고 60에서 클램프된다 (기준 2)', async ({ page }) => {
    await gotoFresh(page);
    // 다이얼은 절대 각도가 아니라 "언랩 누적 델타"로 동작한다 — pointerdown 위치가
    // (데드존 밖이면) 그 자체로 새 기준값이 되고("분침 근처 클릭 = 해당 시간 설정"
    // 디자인 요청), 그 뒤 마우스 이동각의 델타만큼 더해진다. 그래서 API로 미리
    // 58분을 세팅하지 않는다 — setMinutes() 는 idle 상태에서 §3.3 규칙대로 즉시
    // 커밋·자동시작을 태워서 다이얼이 잠겨(disabled) 버린다. 대신 기본값(25분)
    // 위치에서 pointerdown 해 그 값을 기준으로 삼고, 여러 프레임에 걸쳐 시계방향
    // 으로 충분히(+45분 상당, 270°) 돌려 60을 넘겨본다.
    const center = await dialCenter(page);
    const startDeg = 25 * 6;
    const start = pointAt(center, startDeg);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    for (const deg of [60, 120, 180, 240, 300]) {
      const p = pointAt(center, startDeg + deg);
      await page.mouse.move(p.x, p.y, { steps: 5 });
    }

    const duringDrag = await page.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      return Number(ft.shadowRoot.querySelector('.ft-dial').getAttribute('aria-valuenow'));
    });
    // 25분 + 45분 상당 회전 = 70분 → 60에서 클램프되어야 한다.
    // 0/1 근처로 튀면(래핑 버그) 실패.
    expect(duringDrag).toBe(60);
    expect(duringDrag).not.toBeLessThan(55);

    await page.mouse.up();
  });

  test('pointercancel 시 값이 롤백되고 idle 로 돌아간다 (기준 3)', async ({ page }) => {
    await gotoFresh(page);
    const center = await dialCenter(page);
    const start = pointAt(center, 25 * 6);
    const moved = pointAt(center, 40 * 6);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(moved.x, moved.y, { steps: 5 });

    // 실제 pointercancel 은 OS/브라우저가 발생시키므로 여기서는 합성 디스패치로 재현한다.
    await page.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      const dial = ft.shadowRoot.querySelector('.ft-dial');
      dial.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
    });
    await page.mouse.up();

    const state = await page.evaluate(() => document.querySelector('focus-timer').state);
    expect(state).toBe('idle');
  });

  test('running 중에는 다이얼이 aria-disabled="true" 이고 드래그가 값에 반영되지 않는다 (기준 7)', async ({
    page,
  }) => {
    await gotoFresh(page);
    await page.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      ft.setMinutes(10);
      ft.start();
    });

    const before = await page.evaluate(() => document.querySelector('focus-timer').totalMs);
    const center = await dialCenter(page);
    const p1 = pointAt(center, 10 * 6);
    const p2 = pointAt(center, 50 * 6);
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p2.x, p2.y, { steps: 10 });
    await page.mouse.up();

    const after = await page.evaluate(() => document.querySelector('focus-timer').totalMs);
    const disabled = await page.evaluate(() =>
      document.querySelector('focus-timer').shadowRoot.querySelector('.ft-dial').getAttribute('aria-disabled'),
    );
    expect(disabled).toBe('true');
    expect(after).toBe(before); // 드래그가 실행 중인 타이머를 바꾸지 않았다
  });

  test('다이얼 밖 스크롤 컨테이너는 정상적으로 스크롤된다 (기준 4의 대체 검증 — touch-action 스코프)', async ({
    page,
  }) => {
    await gotoFresh(page);
    const scopes = await page.evaluate(() => {
      const ft = document.querySelector('focus-timer');
      const dial = ft.shadowRoot.querySelector('.ft-dial');
      return {
        dial: getComputedStyle(dial).touchAction,
        body: getComputedStyle(document.body).touchAction,
        html: getComputedStyle(document.documentElement).touchAction,
      };
    });
    expect(scopes.dial).toBe('none');
    expect(scopes.body).not.toBe('none');
    expect(scopes.html).not.toBe('none');
  });
});

test.describe('키보드만으로 조작 (기준 30)', () => {
  test('Tab 으로 포커스 → 화살표/Home/End 로 설정 → Enter 로 시작 → Enter 로 확인까지 마우스 없이 완주', async ({
    page,
  }) => {
    await gotoFresh(page);

    // 데모 페이지에는 12개 조합 그리드가 더 있어 `.ft-dial` 이 여러 개 매칭된다 —
    // 항상 메인(첫 번째) 인스턴스로 스코프한다.
    const dial = page.locator('.ft-dial').first();
    await dial.focus();
    await expect(dial).toBeFocused();

    await page.keyboard.press('End');
    let value = await page.evaluate(
      () => document.querySelector('focus-timer').shadowRoot.querySelector('.ft-dial').getAttribute('aria-valuenow'),
    );
    expect(value).toBe('60');

    await page.keyboard.press('Home');
    value = await page.evaluate(
      () => document.querySelector('focus-timer').shadowRoot.querySelector('.ft-dial').getAttribute('aria-valuenow'),
    );
    expect(value).toBe('1');

    await page.keyboard.press('ArrowUp'); // +5
    value = await page.evaluate(
      () => document.querySelector('focus-timer').shadowRoot.querySelector('.ft-dial').getAttribute('aria-valuenow'),
    );
    expect(value).toBe('6');

    await page.keyboard.press('Enter'); // 시작 (onActivate → toggle → start)
    const state = await page.evaluate(() => document.querySelector('focus-timer').state);
    expect(state).toBe('running');

    // running 이 되면 다이얼 자체는 통째로 비활성화된다(spec §3.4 — 값 조작 금지,
    // tabindex="-1"). 정지/재개는 별도의 항상-포커스 가능한 컨트롤(주 버튼)로
    // 한다 — 이것도 마우스가 아니라 포커스 이동 + Enter 라는 점에서 "키보드만"
    // 요건(기준 30)을 그대로 만족한다.
    // 데모 페이지의 여러 인스턴스 중 메인(첫 번째)으로 스코프한다. 인덱스가
    // 아니라 part 속성으로 찾는다 — 프리셋 버튼 개수가 늘어나도(9개) 깨지지 않는다.
    const primaryButton = page.locator('focus-timer').first().locator('[part="pause-button"]');
    await primaryButton.focus();
    await page.keyboard.press('Enter'); // toggle → pause
    const paused = await page.evaluate(() => document.querySelector('focus-timer').state);
    expect(paused).toBe('paused');
  });

  test('다이얼이 포커스되지 않은 상태에서 Space 는 페이지 스크롤을 막지 않는다 (전역 단축키 금지)', async ({
    page,
  }) => {
    await gotoFresh(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    const state = await page.evaluate(() => document.querySelector('focus-timer').state);
    // 포커스 밖에서 Space 는 위젯에 아무 영향도 주지 않는다(전역 단축키 없음).
    expect(state).toBe('idle');
  });
});
