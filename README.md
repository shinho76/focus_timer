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

`--ft-track`(게이지의 미채움/남은 부분)도 6개 테마 전부 `#000000` 으로 통일되어 있다 — 위젯
배경과 같은 검정이라 시각적으로 "비어" 보이고, 채워진 부분(`--ft-gauge`)만 도드라진다. 테마별로
다른 트랙 색을 쓰고 싶으면 `focus-timer[theme="classic"] { --ft-track: #dccdb4; }` 처럼 개별
오버라이드.

## 위젯 안의 옵션 컨트롤

`<focus-timer>` 하단에는 항상 세 그룹의 **세그먼트 버튼**(선택지를 이어붙인 버튼 묶음, 한 번에
정확히 하나만 눌린 상태가 되는 UI)이 붙는다 — HTML 속성으로만 정적으로 고르던 시간/`theme`/`gauge`
를 실행 중에도 클릭 한 번으로 바꿀 수 있다:

- **프리셋 시간 7개**: 5·10·15·20·30·45·60분(숫자만 표기, 한 줄에 들어간다).
- **테마 세그먼트 6개**: `auto`/`classic`/`purple`/`pink`/`sky`/`dark`. 텍스트 라벨 없이 버튼 전체를
  그 테마의 강조색으로 채운다 — 색 자체가 라벨이고, 이름은 `aria-label` 로만 남긴다.
- **게이지 스타일 세그먼트 2개**: "세그먼트"(60개 분 단위 조각, `gauge="segments"`) / "파이 차트"
  (연속 부채꼴, `gauge="sector"`). 텍스트 대신 아이콘으로 구분한다 — 점선 링(띠 모양) = segments,
  꽉 찬 원(균일한 색) = sector. 테마 6개 × 게이지 2개 = 12가지 조합 전부에 이 두 그룹만으로
  도달할 수 있다.

테마·게이지 두 그룹은 한 줄에 작게(`.ft-segmented--compact`) 붙어 있다 — 프리셋 시간 버튼처럼
매번 크게 보일 필요가 없는, 자주 안 바꾸는 설정이라 최소한의 자리만 차지한다. 버튼류(프리셋/±/
시작·리셋·미리듣기/세그먼트)는 전부 순검정 배경 + 옅은 테두리로 통일했다.

셋 다 다이얼의 "값"이 아니라 시간 설정이거나 순전히 겉모습이라 실행 중에도 언제든 바꿀 수 있다
(프리셋은 idle/setting 에서만 의미가 있어 running 중엔 비활성화된다).

기본 위젯 폭은 `max-width: 360px` — 필요하면 `focus-timer { max-width: 480px; }` 로 오버라이드.
`::part()` 노출: `dial` `readout` `gauge` `controls`.

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
npm test          # Vitest 단위 테스트 (306개, core/view/input/ports/runtime 전부)
npx playwright install chromium  # 최초 1회
npm run test:e2e  # Playwright — 실제 브라우저 드래그·키보드·다중 탭 시나리오 (10개)
```

자세한 39개 수용 기준별 검증 상태와 관측값은 [`VERIFICATION.md`](VERIFICATION.md) 참고.
