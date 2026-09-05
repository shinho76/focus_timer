# focus-timer

다이얼을 돌려 시간을 정하면 게이지가 줄어들고, 0에서 알람이 울리는 집중 타이머 커스텀 엘리먼트.
런타임 의존성 0, 외부 네트워크 요청 0건, `<focus-timer>` 태그 하나로 동작한다.

명세: [`docs/spec-v4.md`](docs/spec-v4.md) · 개발 절차: [`focus-timer-dev-plan.md`](focus-timer-dev-plan.md) · 프로젝트 규칙: [`CLAUDE.md`](CLAUDE.md)

## 설치

```bash
npm install
npm run build   # dist/focus-timer.js, dist/focus-timer.min.js 생성
```

```html
<script src="dist/focus-timer.min.js"></script>
<focus-timer default-minutes="25"></focus-timer>
```

빌드 산출물은 런타임 의존성이 0이고 CSS가 인라인(텍스트)으로 포함된 단일 IIFE 번들이다.
`gzip ≤ 20KB` (실측 약 16.2KB), 오프라인·`file://`·CSP `style-src 'self'` 환경에서 그대로 동작한다.

## 속성

| 속성 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `mode` | `simple` \| `pomodoro` | `simple` | 뽀모도로 사이클 레이어 사용 여부 |
| `gauge` | `sector` \| `segments` | `sector` | 연속 부채꼴 / 60개 분 단위 조각 |
| `theme` | `auto` \| `classic` \| `purple` \| `pink` \| `sky` \| `dark` | `auto` | `auto` 는 `prefers-color-scheme` 추종 |
| `max-minutes` | 정수 | `60` | 다이얼 최대값 |
| `default-minutes` | 정수 | `50` | 최초 선택 분 |
| `autostart-on-release` | `on` \| `off` | `on` | 드래그를 놓으면 자동 시작할지 |
| `alarm-length` | `3` \| `30` | `30` | 알람 길이(초), 1초 간격 비프 |
| `volume` | `0` \| `0.35` \| `0.8` | `0.35` | 알람 음량 3단계 |
| `flash` | `on` \| `off` | `on` | 알람 시 화면 점멸(`prefers-reduced-motion` 이면 정적 색 채움) |
| `notify` | `on` \| `off` | `off` | 브라우저 알림 사용(권한은 `requestNotifications()` 로 별도 요청) |
| `title-sync` | `running` \| `off` | `running` | 실행 중 `document.title` 에 남은 시간 표시 |
| `persist` | `local` \| `off` | `local` | `localStorage` 저장/복원 |
| `storage-key` | 문자열 | `focus-timer.v1` | 저장 키/리더 채널 네임스페이스 |
| `lang` | BCP-47 | `ko` | `Intl.NumberFormat` 로케일 |

## CSS 변수 (테마 API)

`--ft-bg` `--ft-gauge` `--ft-track` `--ft-text` `--ft-mark` `--ft-font` `--ft-radius`
`--ft-chassis-bg` `--ft-chassis-fg` — 다이얼 판을 감싸는 "기기 베젤"의 배경/글자색. 6개 테마 어디서도
재정의하지 않으므로 테마와 무관하게 항상 순검정이다(기본 `#000000`/`#e8e8ea`). 밝은 배경을 원하면
`focus-timer { --ft-chassis-bg: #fff; --ft-chassis-fg: #111; }` 처럼 오버라이드.

`--ft-bg`(다이얼 판 전체)·`--ft-track`(게이지의 미채움 부분)·`--ft-text`(중앙 숫자)·`--ft-mark`
(눈금/라벨)도 6개 테마 전부 같은 값(판/트랙은 순검정, 글자/눈금은 밝은 회색)으로 수렴되어 있다
— 이제 테마마다 다른 건 `--ft-gauge`(채워진 호 색) 하나뿐이다. 판·트랙이 위젯 배경과 같은
검정이라 시각적으로 "비어" 보이고, 채워진 호만 도드라진다. 여전히 테마별 오버라이드는 가능하다:
`focus-timer[theme="classic"] { --ft-bg: #f4ebdc; --ft-track: #dccdb4; --ft-text: #2e2a24; }`
처럼 예전 밝은 배경 스타일로 되돌릴 수 있다.

## 위젯 안의 옵션 컨트롤

v1.2 부터 화면을 3단 우선순위로 재배치했다(배경은 `docs/spec-v4.md` §15.2) — 기능은 하나도
빠지지 않았고, 상시 노출 여부만 바뀌었다.

**항상 보이는 것** (다이얼 아래 바로):

- **프리셋 시간 7개**: 5·10·15·20·30·45·60분을 이어붙인 세그먼트 버튼.
- **시작/일시정지/재개/확인 버튼**: 프리셋 옆에 강조색으로.
- **"미세 조정" 펼침 버튼**: 누르면 그 아래로 ± 버튼 6개(−10/−5/−1/+1/+5/+10)와 분 직접 입력이
  펼쳐진다. 프리셋만으로는 부족한 미세 조정을 위한 것이라 기본은 접혀 있다. running 중에는
  다이얼 대신 이 ± 버튼들로 남은 시간을 조정한다.

**아이콘 뒤에 접힌 것** (다이얼 아래, 미세 조정 아래):

- **`+` 버튼**: 오늘의 목표 입력창을 연다 (아래 문단 참고).
- **톱니 버튼**: 설정 패널을 연다 — **테마 세그먼트 6개**(`auto`/`classic`/`purple`/`pink`/`sky`
  /`dark`, 텍스트 없이 버튼 전체를 그 테마 색으로), **게이지 스타일 세그먼트 2개**("세그먼트" =
  점선 링 아이콘/`gauge="segments"`, "파이 차트" = 꽉 찬 원 아이콘/`gauge="sector"`), **리셋**,
  **알람 미리 듣기**. 전부 자주 바꾸지 않는 설정이라 기본은 접혀 있다.

세 컨트롤(프리셋/테마/게이지) 모두 다이얼의 "값"이 아니라 시간 설정이거나 순전히 겉모습이라
실행 중에도 언제든 바꿀 수 있다(프리셋은 idle/setting 에서만 의미가 있어 running 중엔
비활성화된다). 버튼류는 전부 순검정 배경 + 옅은 테두리로 통일했다.

**다이얼을 직접 클릭**해도 된다 — 중심 부근(반경의 20% 안쪽)이 아니라 눈금 근처를 클릭하면 그
자리가 가리키는 시간으로 바로 점프해 커밋된다(프리셋 버튼과 동등하게 autostart). 그대로 끌면
그 지점부터 상대 회전이 이어진다(자세한 동작은 `docs/spec-v4.md` §15.1).

기본 위젯 폭은 `max-width: 400px`(다이얼을 화면의 시각적 중심으로 키운 결과) — 필요하면
`focus-timer { max-width: 480px; }` 로 오버라이드. `::part()` 노출: `dial` `readout` `gauge`
`controls`.

## 위젯 위쪽/아래쪽: 오늘의 목표, 날짜/시각, 명언

원 스펙(§1~§13)에는 없던 화면 구성 요소 3가지가 있다(자세한 배경은 `docs/spec-v4.md` §14,
노출 위치 재배치는 §15.2 참고):

1. **오늘의 목표**: 다이얼 바로 위, 설정돼 있을 때만 보인다. 위 옵션 컨트롤의 `+` 버튼을 누르면
   인라인 입력창이 열린다. 목표를 한 가지(최대 60자)만 입력하고 Enter — 다이얼 바로 위에 강조색
   으로 표시된다. `focus-timer.v1:goal` 이라는 별도 storage 키에 저장되어(현재 인스턴스의
   `persist` 속성과 무관하게 항상 저장) 새로고침 후에도 남아 있다.
2. **상태바**: 위젯 맨 아래, 좌측 오늘 날짜(`YY.MM.DD`), 우측 현재 시각(24시간제, 분까지 — 예
   `23:55`). 1초마다 갱신. 핵심 과업(타이머)보다 우선순위가 낮은 정보라 v1.2 에서 맨 아래로
   옮겼다.
3. **명언 로테이터**: 상태바 아래, "시간의 중요함"을 일깨우는 짧은 격언 20개(벤저민 프랭클린·
   세네카·톨스토이·스티브 잡스·피터 드러커 등, 웹 검색으로 출처 확인 후 정적 배열로 하드코딩 —
   런타임 네트워크 요청은 여전히 0건이다)를 1분마다 순환 표시.

## API

```js
const ft = document.querySelector('focus-timer');
ft.setMinutes(25); ft.start(); ft.pause(); ft.resume(); ft.toggle();
ft.reset(); ft.extend(60_000); ft.skip(); ft.acknowledge();
ft.previewAlarm(); await ft.requestNotifications(); ft.destroy();
FocusTimer.define('my-timer'); // 다른 태그명으로 재정의
```

읽기 전용: `state` `mode` `phase` `remainingMs` `totalMs` `progress` `cycleIndex`
`completedToday` `isLeader` `capabilities`

이벤트(`bubbles:true, composed:true`): `ft:statechange` `ft:tick` `ft:set` `ft:complete`
`ft:ring` `ft:clockanomaly` `ft:error`

## 아키텍처

```
core/(순수 로직, DOM 모름) ← ports/(브라우저 API 어댑터) ← view/·input/(DOM) ← index.js(조립)
```

5개 워크스트림이 파일 단위로 분리되어 병렬 개발되었다(자세한 소유권은 `CLAUDE.md` 참고):
`core/*`(각도·클럭·상태기계·스케줄), `view/*`(SVG 다이얼·리드아웃·스타일),
`input/*`(포인터 드래그·키보드), `ports/*`(오디오·스토리지·알림), `runtime/*`+`modes/*`(라이프사이클·
다중탭 리더·타이틀 소유권·뽀모도로). `src/index.js` 가 이들을 조립한다.

## 브라우저 지원

Chromium/Firefox/Safari 최신 버전. `AudioContext`/`Notification`/`navigator.locks`/
`BroadcastChannel`/`CSSStyleSheet.replaceSync` 가 없으면 기능이 조용히 축소된다(무음,
인페이지 배너, 단일 탭 가정 등) — 예외를 던지지 않는다. Notification/Web Locks 는 HTTPS
필수(localhost 개발은 예외).

## 알려진 한계 (Known limitations)

- **탭을 닫으면 알림/알람이 동작하지 않는다.** 이 탭을 열어둬야 한다.
- **iOS 무음 스위치가 켜져 있으면 Web Audio 로 소리가 나지 않는다** — 웹에서 우회 불가.
  iOS 백그라운드에서는 `AudioContext` 가 인터럽트되어 오디오 클럭 예약도 무의미해진다.
- **iOS Safari(홈 화면 설치 PWA 아님)** 는 `window.Notification` 자체가 없다 —
  `capabilities.notification === false` 로 감지 가능.
- **Android Chrome** 은 `new Notification()` 이 던진다 — 자동으로 잡아서 `null` 을 반환하고
  인페이지 배너로 대체하지만, 데스크톱과 달리 실제 OS 알림은 뜨지 않는다.
- **다중 탭**: 리더 선출(Web Locks → localStorage 하트비트 → 단일 탭 폴백), "리더만
  알람·알림·스토리지 쓰기·title 을 담당" 게이팅, 그리고 팔로워 탭이 리더의 상태를 실시간
  미러링(BroadcastChannel)하는 것까지 모두 구현되어 있다 — 두 탭을 열어두면 항상 같은 잔여
  시간을 보여주고 알람은 리더 탭에서만 한 번 울린다. `test/e2e/runtime.multitab.spec.js` 로
  검증됨.
- **뽀모도로 모드는 API/로직 레이어만 통합되어 있고, 전용 컨트롤 UI(휴식 건너뛰기 버튼,
  사이클 표시기 등)는 데모에 없다.** `mode="pomodoro"` 속성과 `skip()` 메서드로 코드 레벨
  조작은 가능하다.
- **Wake Lock, 파비콘 진행률, 60분 초과, 5초 정밀 모드, 주간 통계 UI, Document
  Picture-in-Picture** 는 spec §12 대로 v1.1 이후 범위로 남겨두었다(스키마만 저장, UI 없음).
- **`global-hotkeys` 는 항상 off** — 위젯 포커스가 없을 때 Space/Enter 로 조작하는 전역
  단축키는 구현하지 않았다(스펙 §8의 opt-in 요구를 최소로 만족: 아예 없음 = 안전).
- **`favicon-sync`** 는 spec §7.3 의 이유(교차 출처 오염·CSP·Safari 불안정)로 기본 OFF 이며
  이번 릴리스에는 켜는 경로 자체를 구현하지 않았다.

## 테스트

```bash
npm test          # Vitest 단위 테스트 (308개, core/view/input/ports/runtime 전부)
npx playwright install chromium  # 최초 1회
npm run test:e2e  # Playwright — 실제 브라우저 드래그·키보드·다중 탭 시나리오 (10개)
```

자세한 39개 수용 기준별 검증 상태와 관측값은 [`VERIFICATION.md`](VERIFICATION.md) 참고.
