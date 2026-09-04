# 다이얼 집중 타이머 — Claude Code 개발 계획서

> 근거 명세: `focus-timer-prompt-v4.md` (3인 교차 검토 2회전 반영)
> 이 문서는 **Claude Code에서 실제로 실행하는 절차서**다. 각 Phase의 프롬프트는 그대로 복사해 쓴다.

---

## 1. 개요

### 1.1 만드는 것
`<focus-timer>` 커스텀 엘리먼트 하나. 다이얼을 돌려 시간을 정하면 게이지가 줄고 0에서 알람이 울린다.

### 1.2 최종 산출물
```
dist/focus-timer.min.js     ← 정본. CSS 인라인 포함, gzip ≤ 20KB, 의존성 0
dist/focus-timer.js         ← 주석 포함 비압축본
demo/index.html             ← 데모 + 테마·게이지 플레이그라운드
demo/csp-test.html          ← style-src 'self' 환경 검증용
README.md                   ← 설치 / 속성표 / CSS 변수표 / API / 알려진 한계
VERIFICATION.md             ← 수용 기준 39항목 관측값 기록표
```

### 1.3 성공 판정
`focus-timer-prompt-v4.md` §11의 **릴리스 차단 기준 17개** 전부 통과.
(1·2·4·5·9·10·11·13·17·18·19·21·23·27·29·32·34)

---

## 2. 기술 결정 (착수 전 확정 — Claude Code에게 고르게 하지 않는다)

| 항목 | 결정 | 근거 |
|---|---|---|
| 언어 | **Vanilla JS (ESM)**, TypeScript 아님 | 런타임 의존성 0 요구. 타입은 JSDoc으로 |
| 빌드 | **esbuild** 단일 명령 | IIFE 번들 + minify + CSS를 텍스트로 import. 설정 10줄 |
| CSS 인라인 | esbuild `loader: { '.css': 'text' }` | §9.2의 `adoptedStyleSheets` 요구를 만족 |
| 단위 테스트 | **Vitest** | 순수 로직(각도·클럭·상태기계) 전담 |
| 통합/E2E | **Playwright** | Shadow DOM·Pointer Events·visibilitychange는 jsdom으로 불가 |
| 렌더링 | **인라인 SVG** | 고DPI 무료, CSS 변수 테마 주입, 접근성 노드 부여 |
| 시간 제어 | **clock/storage/audio/notifier 4종 포트 주입** | §10.1. 이게 없으면 Phase 5 이후 테스트가 전부 수동이 된다 |
| 저장소 | Git, 단일 저장소 | |

> ⚠ **TypeScript를 쓰지 않기로 한 이유**를 CLAUDE.md에 적어둘 것. 안 적으면 Claude Code가 "타입 안전성을 위해" 중간에 도입하려 든다.

---

## 3. 파일 구조

```
focus-timer/
├─ CLAUDE.md                  ← ★ 가장 중요. §5 참조
├─ docs/
│  └─ spec-v4.md              ← focus-timer-prompt-v4.md 복사본 (단일 진실 원천)
├─ src/
│  ├─ index.js                ← 커스텀 엘리먼트 정의, 포트 조립
│  ├─ core/
│  │  ├─ angle.js             ← 각도↔분 변환, 언랩 적분        [Phase 1]
│  │  ├─ clock.js             ← 하이브리드 클럭 + 포트          [Phase 1]
│  │  ├─ machine.js           ← 5상태 기계, 전이표             [Phase 1]
│  │  └─ schedule.js          ← deadline 관리, 정산            [Phase 1]
│  ├─ view/
│  │  ├─ dial.js              ← SVG 생성(눈금·라벨·게이지)      [Phase 2]
│  │  ├─ readout.js           ← 중앙 숫자 표시                 [Phase 2]
│  │  └─ styles.css           ← 테마 6종 CSS 변수              [Phase 2]
│  ├─ input/
│  │  ├─ pointer.js           ← 드래그                        [Phase 3]
│  │  └─ keyboard.js          ← 키보드·프리셋                  [Phase 3]
│  ├─ ports/
│  │  ├─ audio.js             ← AudioContext 예약·언락          [Phase 4]
│  │  ├─ storage.js           ← localStorage + 메모리 폴백      [Phase 5]
│  │  └─ notifier.js          ← Notification + 폴백            [Phase 7]
│  ├─ runtime/
│  │  ├─ lifecycle.js         ← visibility/pageshow/freeze     [Phase 5]
│  │  ├─ leader.js            ← Web Locks + BroadcastChannel   [Phase 6]
│  │  └─ docowner.js          ← title 소유권 레지스트리         [Phase 6]
│  └─ modes/
│     └─ pomodoro.js          ← 사이클 레이어                  [Phase 8]
├─ test/
│  ├─ unit/                   ← Vitest
│  ├─ e2e/                    ← Playwright
│  └─ fakes/                  ← fakeClock, memStorage, spyAudio, spyNotifier
├─ demo/
├─ build.mjs
└─ VERIFICATION.md
```

**설계 원칙 한 줄**: `core/`는 DOM을 모른다. `view/`는 시간을 모른다. 이 경계가 무너지면 Phase 1의 테스트가 전부 무의미해진다.

---

## 4. 개발 단계

각 Phase는 **독립적으로 검증 가능**하도록 순서를 잡았다. UI를 먼저 만들지 않는다 — 이 프로젝트의 진짜 어려운 부분은 클럭과 상태기계이고, 그건 UI 없이 100% 테스트할 수 있다.

### Phase 0 — 셋업 (0.5일)

**목표**: 빌드·테스트가 도는 빈 골격
**산출물**: `CLAUDE.md`, `build.mjs`, vitest/playwright 설정, `test/fakes/` 4종, 빈 `<focus-timer>`가 화면에 뜨는 상태

**Claude Code 프롬프트**
```
docs/spec-v4.md 를 읽고 프로젝트 골격을 만들어줘.

- esbuild로 src/index.js → dist/focus-timer.min.js (IIFE, minify, .css는 text 로더)
- Vitest(단위) + Playwright(E2E) 설정
- test/fakes/ 에 4종 페이크 구현:
  · fakeClock: wall/mono/setTimeout/clearTimeout. advance(ms)가 두 시계를 함께 밀고
    만료된 타이머를 등록 순서대로 발화. wall만/mono만 밀 수 있는 옵션도 필요
  · memStorage: get/set/remove, throwOnWrite 플래그
  · spyAudio: 예약/취소 호출 기록
  · spyNotifier: 표시 호출 기록, 권한 상태 주입
- src/index.js 는 빈 커스텀 엘리먼트만 정의(shadow open, 아직 아무것도 안 그림)
- demo/index.html 에서 태그가 뜨는 것까지 확인

TypeScript 도입 금지. 런타임 의존성 0.
```

**완료 조건**: `npm run build`, `npm test`, `npx playwright test` 3개가 전부 통과(테스트 0건이어도 됨)

---

### Phase 1 — 순수 로직 ★ 최대 난이도 (2~3일)

> 전체 일정의 위험이 여기에 몰려 있다. 여기가 끝나면 나머지는 조립에 가깝다.

**목표**: DOM 없이 각도·클럭·상태기계 완성
**산출물**: `core/` 4개 모듈 + 단위 테스트

**Claude Code 프롬프트**
```
docs/spec-v4.md §2.2(상태 기계), §3.2(각도), §4(하이브리드 클럭) 를 구현해줘.
DOM은 일절 건드리지 않는다 — core/ 는 브라우저 API를 모르고 clock 포트만 받는다.

1) core/angle.js
   - 6° = 1분, 0은 12시 방향, 시계방향
   - 언랩 누적 적분: 프레임 간 각도차를 최단호(±180°)로 정규화해 누적
   - 0/360°에서 클램프 → 59→0, 0→59 로 튀지 않을 것
   - 1분 스냅, Shift 시 5분 스냅

2) core/clock.js
   - spec §4.2 의 하이브리드 알고리즘 그대로
   - gapExpected 플래그: markGap() 호출 후 첫 tick에서만 큰 wall 점프를 인정
   - 잔여 시간은 절대 증가하지 않는다(단조 감소 클램프)
   - wall 되감김 시 clockanomaly 이벤트

3) core/machine.js
   - 5상태: idle/setting/running/paused/ringing
   - spec §2.2 전이표를 그대로 데이터로 표현(코드에 if 사슬로 흩뿌리지 말 것)
   - 금지 전이 7종은 no-op. 예외를 던지지 않고 조용히 무시
   - running 상태에서 start() 재호출 시 새 스케줄 생성 금지(이중 시작 방지)

4) core/schedule.js
   - running: deadlineWall 보관 / paused: remainingMs 보관
   - 만료 정산: grace 90초 이내면 ringing, 초과면 알람 없이 completed + overdueMs

단위 테스트를 함께 작성해줘. 반드시 포함할 케이스:
  각도: 0/60 경계 양방향, 중심 근처 노이즈, 한 바퀴 초과
  클럭: wall만 점프 / mono만 점프 / 둘 다 갭 / wall 되감김 / gapExpected 유무
  기계: 금지 전이 7종 전부 no-op, START 5회 연타 후 스케줄 핸들 1개
  정산: 정확히 만료 / grace 이내 / grace 초과 3시간
```

**완료 조건**: 수용 기준 **1·2·9·10·14·15·17·18** 을 단위 테스트로 증명. `VERIFICATION.md`에 관측값 기재.

---

### Phase 2 — 정적 렌더링 (1일)

**목표**: 값을 주면 그려진다. 인터랙션 없음.

**Claude Code 프롬프트**
```
docs/spec-v4.md §3.1 대로 SVG 다이얼을 그려줘. 아직 입력은 붙이지 않는다.

- 0을 12시에, 시계방향 60분. 5분 간격 숫자 라벨 + 1분 간격 작은 tick
- gauge 속성 2종:
  · sector  : 연속 부채꼴 하나 (path arc)
  · segments: 1분 단위 조각 60개, 남은 분만큼 점등. 조각 간격은 각도의 15~20%
- 중앙 readout: 기본 분만 표시. remaining ≤ 60초일 때만 M:SS
- 테마 6종을 CSS 변수로: classic / purple / pink / sky / dark / auto
  (auto는 prefers-color-scheme 추종)
- styles.css 는 :host { font: inherit; color: inherit; } 로 사이트 상속
- adoptedStyleSheets 우선, 실패 시 <style> 폴백 (spec §9.2 코드 그대로)
- 갱신은 transform/속성 최소 변경으로. 1초 갱신 시 레이아웃 재계산 0회

demo/index.html 에 6개 테마 × 2개 게이지를 한 화면에 나열해서 눈으로 비교 가능하게.
```

**완료 조건**: 수용 기준 **6·8** 통과. 데모에서 12가지 조합이 전부 정상.

---

### Phase 3 — 입력 (1.5일)

**목표**: 다이얼을 돌릴 수 있다. 놓으면 시작한다.

**Claude Code 프롬프트**
```
docs/spec-v4.md §3.2~§3.4 대로 입력을 붙여줘.

드래그(input/pointer.js):
  - setPointerCapture 필수. pointercancel / lostpointercapture 에서 값 롤백
  - touch-action: none 은 다이얼 요소에만. 위젯 전체에 걸면 페이지 스크롤이 죽는다
  - 반지름이 다이얼 반경의 20% 미만이면 이동 무시(중심 근처 각도 노이즈)
  - 우클릭·멀티터치 무시, 드래그 중 user-select: none
  - pointerdown 이 오디오 언락 지점 — 여기서 AudioContext.resume() 훅만 걸어두기
  - pointerup 에 autostart-on-release="on"이면 자동 시작

병렬 입력(input/keyboard.js):
  - 프리셋 버튼 5/10/25/50
  - −1/+1, −5/+5
  - <input type=number min=1 max=60>
  - 다이얼 포커스 시 ←/→ 1분, ↑/↓ 5분, Home/End, PageUp/Down 5분

접근성:
  - 바깥 트랙 = role="slider" + aria-valuemin/max/now + aria-valuetext="25분"
  - 중앙 숫자 = role="timer" + aria-live="off"   ※ 두 role을 같은 요소에 주지 말 것
  - running/paused/ringing 에서 다이얼은 aria-disabled="true", tabindex="-1", 조작 거부
  - Space 전역 단축키 금지. 위젯 내부 포커스일 때만 Space/Enter 동작

Playwright E2E 로 검증:
  0→59, 59→0 경계 드래그 / 다이얼 밖으로 나간 드래그 / 터치 드래그 중 페이지 스크롤 미발생
```

**완료 조건**: 수용 기준 **1·2·3·4·5·7·30** 통과

---

### Phase 4 — 알람 (1일)

**Claude Code 프롬프트**
```
docs/spec-v4.md §5 대로 알람을 구현해줘. 외부 오디오 파일 0개.

- ports/audio.js: OscillatorNode로 비프 생성
- ★ 핵심: JS 타이머로 울리지 말고 만료 시각을 오디오 클럭에 미리 예약한다
  (spec §5.2 의 scheduleAlarm 코드 그대로). 백그라운드 스로틀링과 무관하게 울린다
- alarm-length 3초/30초 → 1초 간격 비프 반복
- volume 0 / 0.35 / 0.8 3단계
- flash on/off: 화면 전체 점멸. prefers-reduced-motion 이면 점멸 대신 정적 색 채움
- pause/reset/acknowledge 시 예약된 노드를 전부 취소할 것 (유령 알람 방지)
- 탭이 활성화되면(visibilitychange) 알람 즉시 정지
- "알람 소리 미리 듣기" 버튼 — 볼륨 0/뮤트를 사용자가 스스로 발견하는 유일한 수단

한계를 README에 적어줘: iOS 무음 스위치가 켜져 있으면 Web Audio는 소리가 나지
않으며 웹에서 우회 불가. iOS 백그라운드에서는 AudioContext가 인터럽트된다.
```

**완료 조건**: 수용 기준 **25·26** 통과

---

### Phase 5 — 지속성 · 라이프사이클 (1.5일)

**Claude Code 프롬프트**
```
docs/spec-v4.md §4.3, §4.4, §7.1 을 구현해줘.

ports/storage.js:
  - 키 네임스페이스 focus-timer.v1:*
  - 스키마 v 불일치 → 조용히 폐기 후 idle
  - 파싱 실패/쿼터 초과/차단 → 메모리 폴백. 타이머 자체는 정상 동작
  - "기록이 저장되지 않습니다" 는 1회만 고지
  - paused 는 deadlineWall: null + remainingMs 로 저장  ← 이거 빠지면
    "일시정지 후 새로고침 = 이미 만료" 버그가 난다

runtime/lifecycle.js:
  - visibilitychange / pagehide(+persisted) / pageshow / freeze / resume / blur / focus
  - pageshow(bfcache 복귀)는 localStorage 복원 경로를 타지 않는다 → 별도 정산 필요
  - hidden 진입 시 clock.markGap()

복원 정산:
  - 만료 ≤ 90초 → ringing, 알람 재생
  - 만료 > 90초 → 알람 없이 "50분 타이머가 N분 전에 끝났습니다" 배너 + [다시 시작]
  - 여러 페이즈를 자동 연쇄 진행하지 않는다
  - 복원된 running 은 사용자 제스처가 없어 AudioContext가 suspended다
    → "소리 켜기" 배너 후 다음 상호작용에서 resume()

fakeClock 으로 자동화하고, 슬립/백그라운드는 Playwright 로 검증.
```

**완료 조건**: 수용 기준 **11·12·13·16·19·20** 통과

---

### Phase 6 — 다중 탭 · 전역 상태 (1일)

**Claude Code 프롬프트**
```
docs/spec-v4.md §7.2, §7.3 을 구현해줘.

runtime/leader.js:
  - navigator.locks 로 리더 선출 (spec 코드 그대로)
  - 리더만: 알람 재생, 알림, 스토리지 쓰기, title 소유
  - 팔로워는 BroadcastChannel 로 받은 상태를 렌더만
  - locks 미지원 시 폴백: localStorage 하트비트 + 최신 타임스탬프 승자
  - destroy() 시 락 해제 → 다른 탭이 승계

runtime/docowner.js:
  - 모듈 스코프 선착순 레지스트리. 인스턴스 2개면 하나만 title 소유
  - claim 시점에 원본 title 스냅샷. SPA 라우팅으로 바뀌면 베이스라인 갱신
  - destroy() 와 pagehide 양쪽에서 원복 (호스트 제목 영구 오염 방지)
  - document.title 은 분 단위로만 갱신. 마지막 1분만 예외
  - 파비콘은 기본 OFF

Playwright 2컨텍스트로 검증: 같은 잔여 시간 표시, 알람 1회만.
```

**완료 조건**: 수용 기준 **21·23·24** 통과

---

### Phase 7 — 알림 · 접근성 마감 (1일)

**Claude Code 프롬프트**
```
docs/spec-v4.md §5.4, §5.5, §8 을 마무리해줘.

ports/notifier.js:
  - 권한 요청은 설정의 "알림 켜기" 토글에서만. 드래그 중에 띄우면 포커스를 뺏겨
    드래그가 끊긴다. 거부 상태를 기억해 재요청하지 않는다
  - Android Chrome 은 new Notification()이 던진다 → try/catch 후 인페이지 폴백.
    브라우저 알림은 데스크톱 한정으로 문서화
  - iOS Safari 는 window.Notification 자체가 없다
  - Notification 클릭 → window.focus()
  - 최종 폴백: 알림·소리가 모두 실패해도 사용자가 돌아온 순간 위젯 전체를
    알람 색으로 채우고 "50분 완료 (3분 전)" + 다음 행동 버튼

접근성 마감:
  - 상태 변화 시에만 aria-live="polite" 로 1회 안내. 문구는 잔여 시간이 아니라
    행동 정보("50분 타이머 시작", "완료, 10분 휴식")
  - prefers-reduced-motion: 게이지 이징·알람 점멸 제거
  - forced-colors: active 에서 게이지 잔량이 구분되도록 두께/패턴 대안
  - 터치 타깃 ≥ 44px, 텍스트 대비 ≥ 4.5:1, 게이지 ≥ 3:1 (6개 테마 전부)
  - Intl.NumberFormat 사용, 문자열 하드코딩 금지
```

**완료 조건**: 수용 기준 **27·28·29·31** 통과. axe 자동검사 violation 0.

---

### Phase 8 — 사이클 모드 (0.5일)

**Claude Code 프롬프트**
```
docs/spec-v4.md §6 의 뽀모도로 사이클을 modes/pomodoro.js 로 얹어줘.
core/ 를 수정하지 말고 그 위에 레이어로 올릴 것.

- mode="simple"(기본) / "pomodoro"
- 기본값 50분 집중 / 10분 휴식 / 3회 후 긴 휴식 30분
- 프리셋으로 25/5/15/4 도 제공, 전부 사용자 변경 가능
- 자동 진행 토글 2개로 분리:
    집중→휴식 자동 시작 (기본 ON) / 휴식→집중 자동 시작 (기본 OFF)
- 건너뛰기: skipped:true 기록, 완료 카운트 미증가
- 사이클 경계: 집중 1~2회 → 짧은 휴식, 집중 3회 완료 → 긴 휴식, 후 cycleIndex=0
- 페이즈는 색 + 텍스트 라벨 병기 (색만으로 구분 금지)
- dailyCounts 스키마는 저장하되 UI는 만들지 않는다(v1.1)
```

**완료 조건**: 수용 기준 **22** 통과. 오프바이원 없음.

---

### Phase 9 — 검증 · 배포 (1일)

**Claude Code 프롬프트**
```
릴리스 준비를 해줘.

1) demo/csp-test.html — Content-Security-Policy 를 style-src 'self'; script-src 'self'
   로 걸고 위젯이 정상 렌더되는지 확인 (adoptedStyleSheets 경로 검증)
2) 번들 크기 측정: gzip ≤ 20KB. 초과하면 어디가 큰지 보고
3) Object.keys(window) 로드 전후 diff = 1 확인
4) Network 패널 10분 구동 요청 0건 확인
5) 백그라운드 CPU, 1초 갱신 시 리페인트 범위, 8시간 힙 증가 측정
6) README.md 작성: 설치 / 속성표 / CSS 변수표 / API / 브라우저 지원 /
   Known limitations (탭을 닫으면 알림이 오지 않는다, iOS 무음 스위치, 등)
7) VERIFICATION.md 에 39개 항목 전부 관측값 기재
```

**완료 조건**: 수용 기준 **32~39** 통과. 릴리스 차단 17개 전부 ☐→☑

---

## 5. CLAUDE.md — 프로젝트 루트에 반드시 둘 것 ★

Claude Code는 매 세션 이 파일을 읽는다. **여기에 없는 규칙은 세션마다 다시 설명해야 하고, 결국 지켜지지 않는다.**

```markdown
# focus-timer

다이얼 집중 타이머 웹 컴포넌트. 명세는 docs/spec-v4.md 가 단일 진실 원천이다.
명세와 코드가 다르면 명세가 맞다. 명세를 바꿔야 한다면 먼저 물어볼 것.

## 절대 규칙 (위반 시 리뷰 거부)
- 런타임 의존성 0. package.json dependencies 는 비어 있어야 한다
- 외부 네트워크 요청 0건. 폰트·이미지·오디오 파일 포함
- innerHTML / outerHTML / document.write 금지. createElement(NS) 만 사용
- 전역에 남기는 심볼은 window.FocusTimer 하나
- TypeScript 도입 금지. 타입은 JSDoc으로
- core/ 는 DOM과 브라우저 API를 모른다. 포트로만 받는다
- view/ 는 시간을 모른다. 값을 받아 그리기만 한다
- 표시 잔여 시간은 절대 증가하지 않는다
- 새 라이브러리를 추가하지 않는다

## 아키텍처
core/(순수 로직) ← ports/(브라우저 API 어댑터) ← view/·input/(DOM) ← index.js(조립)
시간은 clock 포트로만 읽는다. Date.now() / performance.now() 직접 호출 금지.

## 테스트
- core/ 변경 시 Vitest 단위 테스트 필수
- DOM·인터랙션은 Playwright
- 시간이 필요한 테스트는 test/fakes/fakeClock 사용. 실제 대기 금지

## 커밋
Phase 단위로 커밋. 커밋 메시지에 통과한 수용 기준 번호를 적는다.
예: "Phase 1: 하이브리드 클럭 + 상태기계 (수용 기준 1,2,9,10,14,15,17,18)"
```

---

## 6. Claude Code 세션 운영

### 6.1 세션 1개 = Phase 1개
Phase를 넘겨 이어가면 컨텍스트가 오염되고, 앞 Phase의 잠정 결정이 뒤에 눌어붙는다. Phase가 끝나면 커밋하고 **새 세션**을 연다.

### 6.2 검증은 반드시 별도 세션에서
작업한 세션이 자기 작업을 채점하면 통과시킨다. Phase 완료 후 새 세션에서:
```
docs/spec-v4.md §11 의 수용 기준 중 [번호들] 을 검증해줘.
코드를 고치지 말고, 각 항목에 대해 어떻게 확인했는지와 실제 관측값만 보고해줘.
통과하지 못한 항목은 왜 그런지 근거와 함께.
```

### 6.3 명세 변경이 필요할 때
Claude Code가 "명세대로는 어렵다"고 하면 **코드를 타협시키지 말고 명세를 고친다.** 고친 이유를 `docs/spec-v4.md`에 각주로 남긴다. 그래야 다음 세션이 같은 논쟁을 반복하지 않는다.

### 6.4 자주 발생하는 이탈과 대응

| 이탈 | 대응 |
|---|---|
| 라이브러리를 추가하려 함 | CLAUDE.md 절대 규칙 지적. "의존성 0" 재확인 |
| `Date.now()` 직접 호출 | clock 포트 경유로 되돌리기. Phase 5 이후 테스트가 전부 깨진다 |
| core/ 에서 `document` 참조 | 경계 위반. 포트로 빼기 |
| 테스트에서 실제로 대기 | fakeClock.advance() 로 교체 |
| 잔여 시간을 `setInterval` 감산 | 명세 §4.2 위반. deadline 재계산 방식으로 |
| "일단 동작은 합니다"로 마무리 | 수용 기준 번호를 대며 관측값 요구 |

---

## 7. 리스크

| 리스크 | 확률 | 영향 | 대응 |
|---|---|---|---|
| **하이브리드 클럭이 예상보다 까다로움** | 높음 | 큼 | Phase 1에 버퍼 1일. 여기가 막히면 전체가 막힌다. 최악의 경우 `gapExpected` 없이 wall 단독으로 v1을 내고 시계 점프를 알려진 한계로 문서화 |
| 백그라운드 알람이 결국 안 울림 | 중간 | 중간 | 이미 명세가 "정각 보장 안 함"으로 선언. 복귀 시 정산 배너가 최종 폴백이므로 기능 실패는 아님 |
| iOS에서 소리가 안 남 | 높음 | 작음 | 우회 불가. README에 명시하고 flash(화면 점멸)로 대체 |
| 드래그가 모바일에서 부자연스러움 | 중간 | 중간 | Phase 3 완료 즉시 실기 테스트. 최악의 경우 모바일은 프리셋+숫자 입력 우선 노출 |
| gzip 20KB 초과 | 낮음 | 작음 | segments 게이지의 SVG 60조각을 `<use>` 참조로 줄이기 |
| 범위가 다시 커짐 | 중간 | 큼 | v1.1 목록(§12)을 건드리지 않는다. 새 아이디어는 목록에 추가만 |

---

## 8. 일정

| Phase | 내용 | 소요 | 누적 |
|---|---|---|---|
| 0 | 셋업 | 0.5일 | 0.5 |
| **1** | **순수 로직 ★** | **2~3일** | 3.5 |
| 2 | 정적 렌더링 | 1일 | 4.5 |
| 3 | 입력 | 1.5일 | 6 |
| 4 | 알람 | 1일 | 7 |
| 5 | 지속성·라이프사이클 | 1.5일 | 8.5 |
| 6 | 다중 탭 | 1일 | 9.5 |
| 7 | 알림·접근성 | 1일 | 10.5 |
| 8 | 사이클 모드 | 0.5일 | 11 |
| 9 | 검증·배포 | 1일 | **12일** |

각 Phase 뒤에 검증 세션 0.25일씩 별도. 실기 테스트(iOS/Android/절전 복귀)는 Phase 5·7 완료 후 몰아서.

**최소 동작 버전(MVP)은 Phase 4에서 나온다** — 다이얼을 돌리면 게이지가 줄고 알람이 울리는 상태. 7일차. 여기서 한 번 써보고 방향을 점검할 것.

---

## 9. 착수 체크리스트

- [ ] 저장소 생성, `docs/spec-v4.md` 복사
- [ ] `CLAUDE.md` 작성 (§5 그대로)
- [ ] Phase 0 프롬프트 실행
- [ ] `npm run build` / `npm test` / `npx playwright test` 3개 통과 확인
- [ ] `VERIFICATION.md` 에 39개 항목 빈 표 생성
- [ ] Phase 1 착수
