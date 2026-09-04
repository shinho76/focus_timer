# focus-timer

다이얼 집중 타이머 웹 컴포넌트. 명세는 `docs/spec-v4.md` 가 단일 진실 원천이다.
명세와 코드가 다르면 명세가 맞다. 명세를 바꿔야 한다면 먼저 물어볼 것.
개발 절차는 `focus-timer-dev-plan.md` 를 따른다.

## 절대 규칙 (위반 시 리뷰 거부)
- 런타임 의존성 0. package.json dependencies 는 비어 있어야 한다 (devDependencies만 허용: esbuild, vitest, playwright)
- 외부 네트워크 요청 0건. 폰트·이미지·오디오 파일 포함
- innerHTML / outerHTML / document.write 금지. createElement(NS) 만 사용
- 전역에 남기는 심볼은 window.FocusTimer 하나
- TypeScript 도입 금지. 타입은 JSDoc으로
- core/ 는 DOM과 브라우저 API를 모른다. 포트로만 받는다
- view/ 는 시간을 모른다. 값을 받아 그리기만 한다
- 표시 잔여 시간은 절대 증가하지 않는다
- 새 라이브러리를 추가하지 않는다

## 아키텍처
```
core/(순수 로직) ← ports/(브라우저 API 어댑터) ← view/·input/(DOM) ← index.js(조립)
```
시간은 clock 포트로만 읽는다. `Date.now()` / `performance.now()` 직접 호출 금지 (core/runtime 내부).

## 파일 소유권 (병렬 개발 — 절대 다른 에이전트의 파일을 건드리지 않는다)
- **core**: src/core/angle.js, src/core/clock.js, src/core/machine.js, src/core/schedule.js, test/unit/core.*.test.js
- **view**: src/view/dial.js, src/view/readout.js, src/view/styles.css, test/unit/view.*.test.js
- **input**: src/input/pointer.js, src/input/keyboard.js, test/unit/input.*.test.js, test/e2e/input.*.spec.js
- **ports**: src/ports/audio.js, src/ports/storage.js, src/ports/notifier.js, test/unit/ports.*.test.js
- **runtime**: src/runtime/lifecycle.js, src/runtime/leader.js, src/runtime/docowner.js, src/modes/pomodoro.js, test/unit/runtime.*.test.js, test/e2e/runtime.*.spec.js
- **integration (통합 담당만)**: src/index.js, demo/*, README.md, VERIFICATION.md, build.mjs, package.json

## 모듈 간 계약 (구현 세부사항이 달라도 이 시그니처는 고정)
- `core/angle.js`: `export function angleToAccum(prevAccum, prevAngleDeg, newAngleDeg)` → 언랩 누적, `export function accumToMinutes(accum)` → 0~60 정수(6°=1분), `export function minutesToAccum(min)`
- `core/clock.js`: `export function createClock(port)` → `{ tick(), markGap(), get remainingMs(), on(event, cb) }`. port shape: `{ wall(), mono(), setTimeout(fn,ms), clearTimeout(id) }`
- `core/machine.js`: `export const TRANSITIONS` (데이터 테이블), `export function createMachine(initialState)` → `{ send(event, payload), get state(), on('statechange', cb) }`
- `core/schedule.js`: `export function createSchedule(clock)` → `{ start(totalMs), pause(), resume(), reset(), get remainingMs(), get deadlineWall(), settle(nowWall) }`
- `ports/audio.js`: `export function createAudioPort(AudioContextCtor)` → `{ unlock(), scheduleAlarm(remainingMs, volume, lengthSec), previewAlarm(volume), cancelAll() }`
- `ports/storage.js`: `export function createStoragePort(storageImpl, key)` → `{ load(), save(state), clear(), get isPersisted() }`
- `ports/notifier.js`: `export function createNotifierPort(NotificationCtor)` → `{ requestPermission(), show(title, opts), get permission() }`
- `view/dial.js`: `export function renderDial(container, { minutes, maxMinutes, progress, gauge, disabled })`, dial 루트에 `role="slider"` + aria-value* 부여는 view 담당
- `view/readout.js`: `export function renderReadout(container, { minutes, seconds, showSeconds })`, `role="timer" aria-live="off"`는 view 담당
- `input/pointer.js`: `export function attachPointer(dialEl, { onAngleChange, onCommit, onCancel, minRadiusRatio })` — core/angle.js 의 순수함수를 import해서 사용
- `input/keyboard.js`: `export function attachKeyboard(dialEl, { onDelta, onSet })`
- `runtime/lifecycle.js`: `export function attachLifecycle(win, doc, { onHide, onShow, onFreeze, onResume })`
- `runtime/leader.js`: `export function createLeaderElection(locksApi, channelName)` → `{ isLeader, onLeaderChange(cb), release() }`
- `runtime/docowner.js`: `export function claimTitle(instanceId, doc)` / `export function releaseTitle(instanceId, doc)`
- `modes/pomodoro.js`: `export function createPomodoro(schedule, config)` → focus/break 페이즈 레이어, core/를 수정하지 않고 위에 얹는다

이벤트명은 spec §10 그대로: `ft:statechange` `ft:tick` `ft:set` `ft:complete` `ft:ring` `ft:clockanomaly` `ft:error`

## 테스트
- core/ 변경 시 Vitest 단위 테스트 필수
- DOM·인터랙션은 Playwright
- 시간이 필요한 테스트는 test/fakes/fakeClock 사용. 실제 대기(sleep) 금지

## 커밋
Phase/모듈 단위로 커밋. 커밋 메시지에 통과한 수용 기준 번호를 적는다.
예: "core: 하이브리드 클럭 + 상태기계 (수용 기준 1,2,9,10,14,15,17,18)"
