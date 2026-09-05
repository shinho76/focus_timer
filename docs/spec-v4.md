# 다이얼 집중 타이머 웹 위젯 개발 프롬프트 v4.0

> v3 → **v4**: 참고 제품 사진 확인 후 범위·인터랙션 전면 재조정
> 3인 교차 검토(사용자 관점 / 구현자 / QA)의 기술 요구사항은 유지, 기능 범위는 실물에 맞춰 재정의

---

## 0. 참고 제품과 핵심 정정

### 0.1 실물 레퍼런스 (사용자 제공)

**A. nelna 아날로그 다이얼 타이머**
- 원형 다이얼, **연속 부채꼴(sector)** 이 남은 시간을 표시
- 눈금: 0을 12시 방향에 두고 **시계방향 0→55**, 5분 간격 숫자 라벨 + 1분 간격 작은 tick
- 중앙에 물리 노브 — **"앞면 다이얼만 돌리면 자동으로 카운트다운 시작"**
- Pause 버튼(누름=일시정지), Light 버튼(ON/OFF)
- 알람 길이 스위치 **3초 / 30초**, 음량 **3단계(무음 / 작게 / 크게)**
- 컬러 4종: Purple · Classic(그린+베이지) · Pink · Sky Blue
- 다이얼 안 문구 "Great things take time."

**B. 민틱 2세대 구글타이머**
- 검정 원형 화면에 **주황색 세그먼트 조각**(개별 tick 약 60개)으로 잔량 표시
- 중앙에 **큰 디지털 숫자 + M / S 라벨 + ▼ 마커**
- 무소음, 최대 11시간 59분, 최소 단위 5초, 밝기 2단계, 볼륨 3단계

### 0.2 v3에서 뒤집는 결정 두 가지 ⚠

**정정 1 — 다이얼 드래그는 v1 필수다.**
v3에서 3인 중 2인이 "구현·접근성 부담 대비 효용이 낮다"며 v1 제외를 권고했으나, **참고 제품의 유일한 입력 수단이자 정체성이 다이얼**이고 사용자가 "타이머 시간을 사용자가 정하면"을 핵심 동작으로 명시했다. 드래그를 빼면 만들 이유가 없어진다.
→ **드래그를 v1에 넣되, v3에서 지적된 엣지 케이스를 전부 요구사항으로 명문화한다**(§3.2). 프리셋·키보드·숫자 입력은 드래그를 대체하는 게 아니라 **동등한 병렬 수단**으로 함께 제공한다.

**정정 2 — 뽀모도로 자동 사이클은 코어가 아니라 옵션 레이어다.**
사용자 표현: *"타이머 시간을 사용자가 정하면 게이지나 바가 점점 줄어들면서 사용자가 정한 시간 이후에 알람이 울리는 형태가 **기본**"*
참고 제품에는 집중/휴식 자동 전환이 **아예 없다**. 순수 카운트다운 타이머다.
→ **코어(§2) = 설정 → 감소 → 알람.** 뽀모도로 사이클(§6)은 켤 수 있는 모드로 분리한다. v3는 사이클을 코어로 놓아 범위를 과대 설정했다.

### 0.3 시간 단위 정책 (사용자 지정) [^1]
**분(minute)이 기본 단위다.**
- 다이얼 스케일 = **60분 1바퀴**, 스냅 **1분** (Shift 드래그 시 5분 스냅)
- 중앙 표시 = 기본 **분만**(`"23"` + `분` 라벨). **마지막 60초에만 `M:SS`로 전환** [^1]
  → v3의 "집중 방해 안티패턴" 검토 결론과 일치. 매초 갱신되는 큰 숫자는 그 자체가 시선을 끈다
- 최대 설정 시간은 **60분**(제품 A 기준). 60분 초과는 v1.1

[^1]: **v1 디자인 개정으로 대체됨.** 실제 참고 제품 사진(디지털 타이머, "50:00" 표시)을 다시 검토한
  사용자가 "중앙에 항상 `M:SS`로 표시"할 것을 명시적으로 요청 — 위 "분만 표시, 60초 이하만 전환"
  규칙을 **더 이상 따르지 않는다.** idle/setting 에서는 설정된 총 시간을, running 이후엔 남은
  시간을 항상 `분:초` 형식으로 보여준다(`src/index.js` `_render()`). "집중 방해 안티패턴" 우려는
  유효하지만, 참고 제품들이 실제로 상시 `M:SS`(또는 `MM:SS`) 디지털 표시를 쓰고 있어 사용자가
  일관성을 우선하기로 결정했다. `view/readout.js` 자체의 `showSeconds` 파라미터·`formatValue()`
  구현은 두 동작 모두 지원하도록 그대로 두었으므로, 필요하면 호출부(`index.js`)만 되돌리면 된다.

---

## 1. 프로젝트 개요

브라우저에서 동작하는 **다이얼형 집중 타이머 위젯**. 사용자가 다이얼을 돌려 시간을 정하면 게이지가 점점 줄어들고, 0에 도달하면 알람이 울린다.
- 배포처: **자체 HTML 사이트(직접 개발)**
- 모든 데이터는 브라우저 로컬에만 저장, **외부 전송 0건**
- 단일 `<script>` + `<focus-timer>` 태그로 동작

---

## 2. 코어 동작 (v1의 본체)

### 2.1 기본 흐름
```
idle → (다이얼을 돌려 시간 설정) → 손을 떼는 순간 자동 시작 → running
     → 게이지가 0을 향해 감소 → 0 도달 → ringing(알람) → 확인 → idle
```
**드래그를 놓으면 자동으로 카운트다운이 시작된다** (실물과 동일). 별도의 시작 버튼을 누르게 하지 않는다.
단, `autostart-on-release="off"` 속성으로 "설정 후 시작 버튼 누르기" 방식으로 바꿀 수 있어야 한다.

### 2.2 상태 기계 — 5상태
`idle` · `setting` · `running` · `paused` · `ringing`

| 현재 | 트리거 | 다음 | 부수효과 |
|---|---|---|---|
| idle | `pointerdown` on 다이얼 | setting | 오디오 언락(제스처 확보 지점) |
| setting | `pointerup` | running (autostart 시) | deadline 저장, 알람 예약, Wake Lock |
| setting | `pointercancel` | idle | 값 롤백 |
| running | `pause()` | paused | 알람 예약 취소, **`remainingMs` 저장** |
| running | EXPIRE | **ringing** | 알람 재생, 알림, 타이틀 깜빡임 |
| running | `reset()` | idle | 예약 취소 |
| running | 시계 되감김 | running | 잔여 클램프 + `clockanomaly` |
| paused | `resume()` | running | 새 deadline, 알람 재예약 |
| ringing | `acknowledge()` / 알람 자연종료 | idle (또는 사이클 모드면 다음 페이즈) | 완료 기록 |
| ringing | 타 탭 ack | idle | 로컬 알람만 중지 |

**금지 전이 (전부 no-op, 예외 0, 콘솔 에러 0)**
`idle→pause` / `idle→resume` / **`running→start`(이중 시작 방지 — 더블클릭 2배속 고전 버그)** / `paused→pause` / `running→resume` / `running 중 다이얼 조작`(§3.4) / `destroyed 후 모든 이벤트`

### 2.3 조작
| 명령 | 동작 |
|---|---|
| 다이얼 드래그 | 시간 설정 (놓으면 자동 시작) |
| 일시정지 / 재개 | 실물의 Pause 버튼에 대응 |
| **+1분 / −1분** | 실행 중 미세 조정. 몰입 중 종료를 미룰 수 있어야 한다 |
| 리셋 | idle로. 기록 없음 |
| 프리셋 버튼 | 5 / 10 / 25 / **50** 분 (§6의 사이클 모드 기본값과 일치) |

---

## 3. 다이얼 — 표시와 입력

### 3.1 시각 사양

**공통 지오메트리**
- 0을 **12시 방향**에 두고 **시계방향** 진행. 60분 = 360°, 1분 = 6°
- 눈금 라벨 5분 간격(0, 5, 10 … 55), 1분 간격 작은 tick
- 잔량 영역은 **0에서 시계방향으로 남은 분만큼** 채워지고, 시간이 지나면 **끝단이 0을 향해 되감기며 줄어든다**
- 중앙: 큰 숫자(기본 분) + 단위 라벨. 민틱처럼 `M`/`S` 라벨과 ▼ 마커를 둘 수 있다

**두 가지 게이지 스타일 (속성으로 선택)**

| `gauge` | 모양 | 참고 |
|---|---|---|
| `sector` (기본) | 연속 부채꼴 하나 | nelna |
| `segments` | 1분 단위 개별 조각 60개, 남은 분만큼 점등 | 민틱 |

`segments`는 **분 단위 경계가 눈에 보인다**는 장점이 있어 "분이 기본 단위"라는 요구와 잘 맞는다. 조각 사이 간격은 각도의 15~20%.

**테마 프리셋** (실물 컬러 대응, CSS 변수로 구현)

| 이름 | 배경 | 게이지 | 비고 |
|---|---|---|---|
| `classic` | 크림 베이지 | 딥 그린 | nelna Classic |
| `purple` / `pink` / `sky` | 파스텔 | 동계열 채도 | nelna 3종 |
| `dark` | 근사 검정 | 앰버 오렌지 | 민틱 |
| `auto` | `prefers-color-scheme` 추종 | | 기본값 |

### 3.2 드래그 구현 요구사항 (v3 검토에서 나온 함정 전부 명문화)

```js
// 0/60 경계 되감기 방지: 절대 각도가 아니라 '언랩된 누적 각도'를 적분
onMove(e) {
  const a = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
  let d = a - this.lastAngle;
  if (d > 180) d -= 360; else if (d < -180) d += 360;   // 최단호 정규화
  this.accum = Math.min(360, Math.max(0, this.accum + d)); // 0/60분에서 클램프
  this.lastAngle = a;
  this.setMinutes(Math.round(this.accum / 6));           // 6° = 1분
}
```
필수 처리:
- `setPointerCapture(e.pointerId)` + `pointercancel` / `lostpointercapture` 에서 값 롤백
- **`touch-action: none`은 다이얼 요소에만.** 위젯 전체에 걸면 페이지 스크롤이 죽는다
- **중심 근처 각도 노이즈**: 반지름이 다이얼 반경의 20% 미만이면 이동 무시
- 우클릭·멀티터치 무시, 드래그 중 `user-select: none`
- **한 바퀴를 넘겨 59→0으로 튀지 않는다** (위 클램프)
- 드래그 중 실시간으로 중앙 숫자와 게이지가 함께 갱신

### 3.3 드래그가 아닌 병렬 입력 수단 (동등 지위)
- 프리셋 버튼 5 / 10 / 15 / 20 / 25 / 30 / 40 / 50 / 60분 [^3]
- `−1 / +1`, `−5 / +5` 버튼
- 숫자 직접 입력 (`<input type="number" min="1" max="60">`)
- **키보드**: 다이얼에 포커스 → ←/→ 1분, ↑/↓ 5분, Home/End 최소/최대, PageUp/Down 5분

[^3]: **v1 디자인 개정.** 원래 4개(5/10/25/50)였으나 사용자가 "5,10,15,20,25,30,40,50,60 은
  세그먼트 버튼으로" 요청 — 9개로 늘리고, 개별 알약 버튼 대신 하나로 이어붙인 "세그먼트 버튼"
  (`.ft-segmented`) 묶음으로 바꿨다. `input/keyboard.js` 의 `PRESET_MINUTES` 상수만 바뀌었고
  나머지 배선(프리셋 클릭 → 자동시작)은 그대로다.

### 3.4 running 중 다이얼 조작 정책
**거부한다.** 실물도 돌리면 값이 바뀌어버리므로 오해의 소지가 있다.
- running/paused/ringing 상태에서 다이얼은 `aria-disabled="true"`, `tabindex="-1"`, 커서 `default`
- 시간을 바꾸려면 리셋 먼저. 미세 조정은 §2.3의 `±1분` 버튼으로
- ⚠ **`role="timer"`와 `role="slider"`를 같은 요소에 줄 수 없다.** 바깥 트랙 = `slider`(idle에서만 활성), 중앙 숫자 = `timer` + `aria-live="off"`

---

## 4. 시간 정확성 — 하이브리드 클럭

### 4.1 정직한 요구사항 (v3에서 확립, 유지)
**"만료 순간 정각 알림"은 순수 클라이언트 웹에서 달성 불가능하다.** 백그라운드 탭 타이머는 숨김 5분 후 분당 1회로 정렬되어 최대 ~60초 지연되고, Web Worker 타이머도 함께 스로틀링되며, Service Worker는 자기를 미래에 깨울 API가 없다. Notification Triggers는 표준화되지 않았다.

→ **3단 방어로 명세한다: ① 포그라운드 정확(±200ms) ② 백그라운드 최선 노력(오디오 클럭 예약) ③ 복귀 시 정직한 정산.**

### 4.2 클럭 전략
`Date.now()` 단독은 NTP·수동 시계 변경에 점프하고, `performance.now()` 단독은 플랫폼에 따라 절전 중 정지한다. **델타 누적 + 교차검증**한다.

```js
const MAX_JUMP = 2000;
tick() {
  const p = clock.mono(), w = clock.wall();
  const dp = p - this.lastP, dw = w - this.lastW;
  let d;
  if (dw < 0)                   d = dp;                          // 시계 되감김 → 벽시계 폐기
  else if (dw > dp + MAX_JUMP)  d = this.gapExpected ? dw : dp;  // 절전복귀면 dw 채택
  else                          d = Math.max(dp, dw, 0);
  this.remaining = Math.min(this.remaining - d, this.remaining); // 절대 증가 금지
  this.lastP = p; this.lastW = w; this.gapExpected = false;
}
```
`gapExpected`는 `visibilitychange(hidden)` / `freeze` / `pagehide(persisted)` 에서 세우고, 복귀 시에만 벽시계의 큰 점프를 실제 경과로 인정한다.

**표시 잔여 시간은 절대 증가하지 않는다.** 카운트다운이 거꾸로 올라가면 즉시 버그.

### 4.3 Page Lifecycle 전체 커버
`visibilitychange` 만으로 부족: `pagehide(+persisted)`, **`pageshow`(bfcache 복귀 — JS 상태는 살아있지만 시간은 흘렀다. localStorage 복원 경로를 타지 않으므로 별도 정산 필요)**, `freeze`/`resume`, `blur`/`focus`

### 4.4 장시간 부재
- 만료 후 ≤ **90초(grace)** → `ringing`, 알람 재생
- 만료 후 > 90초 → **알람 없이** "50분 타이머가 2시간 47분 전에 끝났습니다" 배너 + [다시 시작]. 놀라게 하지 않는다
- 사이클 모드(§6)에서도 **여러 페이즈를 자동 연쇄 진행하지 않는다.** 하지 않은 세션이 통계에 쌓인다

---

## 5. 알람 — 실물의 3단계 설정을 그대로

### 5.1 실물 대응 설정
| 실물 스위치 | 웹 속성 | 값 |
|---|---|---|
| 알람 시간 3S / 30S | `alarm-length` | `3` / `30` (초) |
| 음량 무음/작게/크게 | `volume` | `0` / `0.35` / `0.8` |
| Light ON/OFF | `flash` | `on` / `off` — 화면 전체를 페이즈 색으로 점멸(30초 알람 시 약 30회) |

`flash`는 실물의 라이트에 대응하는 시각 알람이며, **소리가 실패해도 도달하는 유일한 신호**라 기본 ON을 권장한다. 단 `prefers-reduced-motion`에서는 점멸 대신 정적 색 채움.

### 5.2 오디오 클럭 예약 (백그라운드 정확도의 실질적 최선)
JS 타이머로 알람을 울리는 설계 자체가 문제다. 오디오 그래프는 별도 스레드에서 렌더링되므로 **만료 시각을 오디오 클럭에 미리 예약하면 JS 스로틀링과 무관하게 울린다.**

```js
function scheduleAlarm(ctx, remainingMs, volume, lengthSec) {
  const t0 = ctx.currentTime + remainingMs / 1000;
  const stops = [];
  for (let i = 0; i < lengthSec; i++) {          // 1초 간격 비프 반복
    const t = t0 + i, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.4);
    stops.push(() => { try { osc.stop(); } catch {} });
  }
  return () => stops.forEach(f => f());   // pause/reset/ack 시 반드시 전부 취소
}
```
한계 명시: 오디오 클럭 드리프트는 60분에 수십 ms(무시 가능). **iOS/모바일에서는 무의미**(백그라운드 진입 시 `AudioContext` 인터럽트로 `currentTime` 정지). **iOS 무음 스위치가 켜져 있으면 Web Audio는 소리가 나지 않고 웹에서 우회 불가** → UI에 문구.

### 5.3 오디오 언락 재획득
드래그 `pointerdown`이 제스처 확보 지점이다. 다만 **새로고침 후 복원된 running 상태에는 제스처가 없어 컨텍스트가 suspended로 남고 알람이 무음으로 실패한다.** → "소리 켜기" 배너 표시 후 다음 상호작용에서 `resume()`.

### 5.4 플랫폼 현실 (progressive enhancement)
- **Android Chrome**: `new Notification()`은 던진다 → `ServiceWorkerRegistration.showNotification()` 필수, 즉 SW 등록(=요청 1건)이 필요 → **브라우저 알림은 데스크톱 한정**으로 명시
- **iOS Safari**: 홈 화면 설치 PWA가 아니면 `window.Notification` 자체가 없음
- 모든 알림 호출을 try/catch로 감싸고 실패 시 인페이지 배너로 폴백

### 5.5 필수 대응
- **"알람 소리 미리 듣기" 버튼** — 볼륨 0/뮤트를 사용자가 스스로 발견하는 유일한 수단. 비용 거의 0
- 알람은 탭이 활성화되면(`visibilitychange`) 즉시 정지
- Notification 클릭 → `window.focus()`
- **최종 폴백**: 알림·소리가 모두 실패해도 사용자가 돌아온 순간 **위젯 전체를 알람 색으로 채우고** "50분 완료 (3분 전)" + 다음 행동 버튼. 작은 토스트로는 부족
- 알림 권한 요청은 **설정의 명시적 "알림 켜기" 토글에서만**. 드래그 시작에 권한 프롬프트를 겹치면 포커스를 뺏겨 드래그가 끊긴다. 거부 상태를 기억해 재요청하지 않는다
- **문서에 명시: 탭을 닫으면 알림이 동작하지 않는다.** "이 탭을 열어두세요"가 정직하다
- `document.title`은 **분 단위로만 갱신** (마지막 1분 예외). 초마다 흔들리면 탭 폭이 들썩이고 시선을 끈다

---

## 6. 뽀모도로 사이클 모드 (옵션 레이어)

`mode="pomodoro"` 일 때만 활성. 기본은 `mode="simple"`(순수 카운트다운).

- **기본값 50분 집중 / 10분 휴식 / 3회 반복 후 긴 휴식 30분** — 사용자가 제시한 학습법 이미지 기준
- 프리셋으로 25/5/15/4(고전 뽀모도로)도 제공. 전부 사용자 변경 가능
- **자동 진행은 토글 2개로 분리** (하나로 묶으면 반드시 불만이 나옴)
  - `집중 종료 → 휴식 자동 시작`: 기본 **ON**
  - `휴식 종료 → 집중 자동 시작`: 기본 **OFF** (자리를 비웠을 수 있으므로)
- **건너뛰기(Skip)**: 휴식이 필요 없을 때. `skipped:true` 기록, 완료 카운트 미증가
- 사이클 경계: 집중 1~2회 완료 → 짧은 휴식, **집중 3회 완료 → 긴 휴식**, 긴 휴식 종료 시 `cycleIndex = 0`
- 페이즈는 **색 + 텍스트 라벨 병기** (색만으로 구분 금지 — 색각 이상 대응)

---

## 7. 상태 유지 · 다중 탭

### 7.1 저장 스키마 (`paused`는 deadline이 무의미 — v3 초안의 내부 모순)
```json
{ "v": 1, "state": "running", "mode": "simple", "phase": "focus",
  "totalMs": 3000000, "deadlineWall": 1757000000000, "remainingMs": null,
  "cycleIndex": 1, "dayKey": "2026-09-04", "completedToday": 3,
  "dailyCounts": { "2026-09-03": 8 }, "settings": {...}, "savedAtWall": 1756999100000 }
```
- `paused` → `deadlineWall: null, remainingMs: <수>`
- 키 네임스페이스 `focus-timer.v1:*`, `storage-key` 속성으로 분리 가능
- **`v` 불일치 → 조용히 폐기 후 idle.** 없으면 v2 업데이트 시 기존 데이터가 깨진다
- **`dailyCounts` 스키마는 v1에 넣고 UI는 v1.1로** — 비용 거의 0인데 나중에 주간 뷰를 붙일 수 있다
- 접근 실패(프라이빗 모드/쿼터 초과) → **메모리 폴백으로 타이머는 정상 동작**, "기록이 저장되지 않습니다" 1회만 고지

### 7.2 다중 탭
같은 사이트를 두 탭 열면 각 탭이 독립 타이머를 돌리고 서로 덮어쓴다. 알람이 두 번 울린다.

**Web Locks 리더 선출 + `BroadcastChannel` 미러:**
```js
navigator.locks.request('focus-timer-leader', { mode: 'exclusive' }, () =>
  new Promise(release => {
    this.isLeader = true; this.bc.postMessage({ type: 'leader-changed' });
    this.releaseLeadership = release;   // destroy() 시 다른 탭이 승계
  })
);
```
리더만: 알람 재생, 알림, 스토리지 쓰기, title 소유. 팔로워는 렌더만.
미지원 시 폴백: localStorage 하트비트 + 최신 타임스탬프 승자.
**최소 요구: 모든 탭이 같은 잔여 시간을 보이고 알람은 한 번만 울린다.**

### 7.3 전역 상태 소유권
```js
const DocOwner = { title: null };   // 모듈 스코프 선착순 레지스트리
claim(inst) { if (DocOwner.title && DocOwner.title !== inst) return false;
              DocOwner.title = inst; return true; }
release(inst) { if (DocOwner.title === inst) { restore(); DocOwner.title = null; } }
```
- 원본 `title`은 claim 시점 스냅샷. SPA 라우팅으로 바뀌면 베이스라인 갱신
- **`pagehide`에서도 원복** (destroy 누락 시 호스트 제목 영구 오염 방지)
- **파비콘 진행률은 기본 OFF (opt-in)**: `<link rel=icon>`이 여러 개일 수 있어 전부 기억·복원해야 하고, 교차 출처 이미지를 캔버스 합성하면 tainted → `toDataURL()` 예외. data URL은 `img-src 'self'`에서 차단. Safari 반영도 불안정

---

## 8. 접근성

- 중앙 숫자: **`role="timer"` + `aria-live="off"`. 매초 낭독 금지**
- 상태 변화 시에만 **별도 `aria-live="polite"` 영역에서 1회** 안내. 문구는 잔여 시간이 아니라 **행동 정보**("50분 타이머 시작", "완료, 10분 휴식")
- 다이얼: `role="slider"`, `aria-valuemin="1" aria-valuemax="60"`, **`aria-valuetext="25분"`**, running 중 `aria-disabled="true"`
- **Space 전역 단축키 금지** — Space는 페이지 스크롤 기본 동작이다. "입력 필드 제외"만으로 부족. **기본 off, 위젯 내부 포커스일 때만 Space/Enter 동작.** 전역이 필요하면 `global-hotkeys` opt-in
- `prefers-reduced-motion: reduce` → 게이지 전환 애니메이션과 알람 점멸 제거 (정적 색 채움으로 대체)
- 터치 타깃 ≥ 44×44 CSS px, 텍스트 대비 ≥ 4.5:1, 게이지/눈금 ≥ 3:1 (모든 테마에서)
- **`forced-colors: active`**: SVG `stroke`가 시스템 색으로 강제되어 잔량 구분이 사라진다 → 두께/패턴 대안 명세
- `Intl.NumberFormat` 사용, 문자열 하드코딩 금지

---

## 9. 패키징

### 9.1 Shadow DOM — 유지, 단 이유는 격리가 아니라 패키징
자체 사이트라 "적대적 CSS 방어" 명분은 약하다. 그래도 커스텀 엘리먼트 하나로 lifecycle이 붙고 정리 로직이 강제되며 다른 프로젝트에 그대로 붙는다.
- `:host { font: inherit; color: inherit; }` — **사이트 폰트/색 상속이 기본**
- **CSS 변수를 공개 테마 API로 문서화**: `--ft-bg`, `--ft-gauge`, `--ft-track`, `--ft-text`, `--ft-mark`, `--ft-font`, `--ft-radius`,
  **`--ft-chassis-bg`, `--ft-chassis-fg`** [^2]
- `::part()` 노출: `part="dial gauge readout controls pause-button"`
- `aria-labelledby`는 **shadow 경계를 넘지 못한다** → 레이블은 위젯 안에 두거나 `aria-label` 문자열로 받는다
- **`open` 모드 필수** (`closed`는 이득 없이 디버깅만 어렵게 함)

[^2]: **v1 디자인 개정 추가.** 사용자가 참고 제품 사진을 보고 "다이얼이 표시되는 부분(원판) 외의
  배경은 검정 계통으로" 요청 — 다이얼 판 자체는 기존처럼 `--ft-bg`(테마별로 다름)를 쓰지만, 그
  판을 감싸는 위젯 전체 배경("기기 베젤")은 6개 테마 블록 어디에도 재정의하지 않아 테마와 무관하게
  항상 어둡다(`--ft-chassis-bg` 최초값 `#0b0b0e` → 사용자가 "약간 옅은 색도"로 재요청해 `#1c1c22`
  차콜톤으로 한 단계 조정). 동시에 6테마×2게이지 12조합을 위젯 안에서 바로 전환할 수 있는 컨트롤을
  추가했고, 이후 프리셋 버튼(§3.3, [^3])과 시각적으로 통일하기 위해 원형 스와치/단일 토글 버튼에서
  "세그먼트 버튼"(여러 선택지를 이어붙인 버튼 묶음, `.ft-segmented`) 컴포넌트로 다시 바꿨다 — HTML
  속성(`theme`/`gauge`)만으로 정적으로 고르던 것을, 실행 중에도 클릭 한 번으로 바꿀 수 있게 한 것.
  이어서 사용자가 "테마/게이지 세그먼트에서 텍스트를 지우라"고 요청 — 테마 세그먼트는 버튼 전체를
  그 테마의 강조색으로 채워 색 자체가 라벨이 되게, 게이지 세그먼트는 아이콘(점선 링=segments,
  꽉 찬 원=sector)으로 대체했다. 스크린리더용 이름은 `aria-label`로만 남아 접근성은 그대로다.
  데모 페이지(`demo/index.html`)의 "테마×게이지 12조합" 비교 그리드도 같은 요청으로 삭제했다 —
  위젯 자체에 실시간 선택 컨트롤이 생긴 뒤로는 12개 인스턴스를 나란히 두는 게 중복이었다.
  다음으로 사용자가 렌더링된 스크린샷에 직접 빨간 마킹을 남겨 두 가지를 더 요청했다: (1) 테마/
  게이지 세그먼트가 "시각적으로 너무 크다"며 높이 ~1/3·폭 ~1/2 로 줄이고 한 줄에 붙일 것 →
  `.ft-segmented--compact` 로 대응, 두 그룹을 별도 줄 대신 `.ft-option-row--compact` 한 줄에 배치.
  (2) 버튼류의 반투명 회색 배경(`rgba(255,255,255,0.05~0.1)`)과 위젯 배경(`--ft-chassis-bg`,
  당시 `#1c1c22`)이 전부 "검정색으로" → 순검정(`#000000`)으로 되돌리고, 배경이 순검정이라 안 보이게
  된 버튼 경계는 테두리 불투명도를 올려(`rgba(255,255,255,0.16)`) 대신 구분한다. 다이얼 판 자체
  (`--ft-bg`, 테마별)와 게이지 트랙(`--ft-track`)은 대상에서 제외했다 — 마킹이 명확히 버튼·여백
  쪽이었고, 트랙까지 검정으로 밀면 밝은 테마(classic/purple/pink/sky)에서 대비가 부자연스러워진다.
  기존 공개 속성/이벤트 계약은 바뀌지 않았다.

### 9.2 CSP
JS로 만든 `<style>`은 `style-src` 인라인 검사를 받는다. `style-src 'self'` 사이트에서 스타일이 통째로 죽는다.
```js
let sheet;
try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS_TEXT); shadow.adoptedStyleSheets = [sheet]; }
catch { const s = document.createElement('style'); s.textContent = CSS_TEXT; shadow.append(s); }
```
추가 지뢰: 파비콘 data URL(`img-src`), Blob 워커(`worker-src blob:`), **Trusted Types 사이트에서는 `<template>.innerHTML`도 막힘** → `createElement` 기반 빌더

### 9.3 기타
- 전역 심볼 1개, `innerHTML`/`document.write` 금지
- 외부 요청 0건(폰트·이미지·오디오 포함), 오프라인·`file://` 동작
- Notification / Wake Lock / Web Locks는 **HTTPS 필수**(localhost 개발은 OK)
- **Wake Lock은 `visible`일 때만 획득 가능하고 hidden이 되면 자동 해제** → 백그라운드 정확도에 도움이 안 되고 "화면 켜둔 채 집중" 용도만. `visibilitychange`에서 재획득, `destroy()`에서 해제
- **텔레메트리 없음**을 계약으로 명시

---

## 10. 공개 API

```html
<focus-timer
  mode="simple"                     <!-- simple | pomodoro -->
  gauge="sector"                    <!-- sector | segments -->
  theme="auto"                      <!-- auto | classic | purple | pink | sky | dark -->
  max-minutes="60" default-minutes="50"
  autostart-on-release="on"
  alarm-length="30" volume="0.35" flash="on"
  notify="off" title-sync="running" favicon-sync="off"
  keep-awake="off" global-hotkeys="off"
  persist="local" storage-key="focus-timer.v1" lang="ko"></focus-timer>
```

**메서드**: `setMinutes(n)` `start()` `pause()` `resume()` `toggle()` `reset()` `extend(ms)` `skip()` `acknowledge()` `previewAlarm()` `requestNotifications()` `destroy()` / `static define(tag)`
**읽기 전용**: `state` `mode` `phase` `remainingMs` `totalMs` `progress` `cycleIndex` `completedToday` `isLeader` `capabilities{audio,notification,wakeLock,locks,persist}`
**이벤트** (`bubbles:true, composed:true`): `ft:statechange` `ft:tick` `ft:set{minutes}` `ft:complete{plannedMs,actualMs,skipped,overdueMs}` `ft:ring` `ft:clockanomaly{kind,deltaMs}` `ft:error{code}`

### 10.1 테스트 주입 — `now()` 하나로는 불가능
`now()`만 주입하면 `setTimeout`, `AudioContext.currentTime`, 이벤트 루프를 못 잡아 빨리감기가 안 된다. **4종 포트를 통째로 주입**한다.
```js
FocusTimer.create({ clock, storage, audio, notifier });
// clock = { wall, mono, setTimeout, clearTimeout }
// fake.advance(50*60*1000) 이 wall/mono를 함께 밀고 만료 타이머를 순서대로 발화
```
반드시 커버: wall만 점프 / mono만 점프 / 둘 다 갭 / wall 되감김 / 정확히 만료 / grace 초과 만료 / paused 복원 / 리더 승계

---

## 11. 수용 기준 (측정 가능)

**다이얼 · 표시**
| # | 기준 | 측정 |
|---|---|---|
| 1 | 드래그 각도 → 분 변환 오차 **0** (1분 스냅), 6°=1분 | 단위 테스트 |
| 2 | **0/60 경계에서 값이 반대편으로 튀지 않음** (59→0, 0→59 양방향) | 수동 + 단위 |
| 3 | 드래그가 다이얼 밖으로 나가도 추적 유지, `pointercancel` 시 값 롤백 | 수동 |
| 4 | 다이얼 위 터치 드래그 시 **페이지 스크롤 미발생**, 다이얼 밖은 정상 스크롤 | 모바일 실기 |
| 5 | 중앙 표시가 **60초 초과 시 분만**, 60초 이하에서 `M:SS` 전환 | 시계 주입 |
| 6 | 게이지 잔량 각도 = `remaining/총시간 × 설정각` 오차 ≤ 0.5° | 계산 대조 |
| 7 | running 중 다이얼 조작 **거부**, `aria-disabled` 반영 | 수동 |
| 8 | 6개 테마 전부 대비 텍스트 ≥ 4.5:1, 게이지 ≥ 3:1 | 대비 측정 |

**시간 정확성**
| # | 기준 | 측정 |
|---|---|---|
| 9 | 포그라운드 만료 오차 **≤ ±200ms** (5회 최댓값) | 타임스탬프 로그 |
| 10 | 50분 구동 중 표시 분 **단조 감소, 중복 0, 스킵 0** | 표시값 diff |
| 11 | 백그라운드 30분 복귀 오차 **≤ 1초**, 반영 ≤ 500ms | 실기 |
| 12 | 슬립 8시간 복귀 판정 100% 정확 | 실기 + 주입 |
| 13 | 만료 3시간 후 복귀: **알람 없이 배너**, 자동 진행 0회 | 시계 주입 |
| 14 | 시스템 시계 ±2시간 변경 시 잔여 점프 없음 | OS 시계 변경 |
| 15 | DST 전환 통과 시 실경과대로 만료 | 가짜 TZ |
| 16 | bfcache 뒤로가기 복원 오차 ≤ 1초 | `pageshow` |

**상태 · 견고성**
| # | 기준 | 측정 |
|---|---|---|
| 17 | **START 5회 연타 → 내부 핸들 1개, 60초당 감소 60±1초** | 단위 테스트 |
| 18 | 금지 전이 7종 전부 no-op, 예외 0 | 전이 매트릭스 |
| 19 | paused 상태로 새로고침 → 잔여 시간 **동결 복원**(경과 미차감) | 실기 |
| 20 | localStorage 차단/가득참/손상 3종에서 타이머 정상 동작 | 프라이빗 + 스텁 |
| 21 | 두 탭 동시: 같은 잔여 시간, **알람 1회만** | 실기 2탭 |
| 22 | 사이클 모드 경계: 집중 1~2→짧은휴식, **집중 3→긴휴식**, 후 cycleIndex=0 | 3사이클 완주 |
| 23 | `destroy()` 후 `document.title` **정확 일치(===)**, 잔여 콜백 0 | 자동 assert |
| 24 | 위젯 2개 독립 동작, title 소유권 단일, 하나 destroy 시 승계 | 실기 |

**알람 · 접근성 · 성능**
| # | 기준 | 측정 |
|---|---|---|
| 25 | 알람 길이 3초/30초 실측 오차 ≤ 0.3초, 음량 3단계 구분 | 오디오 캡처 |
| 26 | 음소거 시 실제 무음(피크 0) | 오디오 캡처 |
| 27 | 만료 시 알람 1회·알림 1회 (백그라운드 포함, 복귀 중복 0) | 실기 |
| 28 | 알림 권한 거부/차단 시 무오류 대체, 재요청 루프 0 | 3가지 권한 상태 |
| 29 | **스크린리더 초 단위 발화 0회/분**, 상태 변화 발화 정확히 1회 | NVDA+Chrome, VO+Safari |
| 30 | **키보드만으로 시간 설정·시작·정지 완주** | 마우스 미사용 |
| 31 | `prefers-reduced-motion`에서 점멸·이징 제거 | OS 설정 on |
| 32 | 네트워크 요청 **0건** (10분 구동) | Network 패널 |
| 33 | 전역 키 diff **= 1** | `Object.keys(window)` 스냅샷 |
| 34 | **CSP `style-src 'self'` 사이트에서 정상 렌더**, 위반 0 | 테스트 호스트 |
| 35 | 백그라운드 CPU **≤ 0.5%**, rAF 0회 | 작업관리자 5분 |
| 36 | 1초 갱신 시 **문서 전체 리페인트 0회** | Paint flashing |
| 37 | 8시간 구동 힙 증가 ≤ 2MB, detached node 0 | 스냅샷 3회 |
| 38 | gzip ≤ 20KB, 초기화 ≤ 30ms, 의존성 0 | 빌드 산출물 |
| 39 | 전 시나리오 콘솔 에러·경고 **0건** | 회귀 1회전 |

**릴리스 차단**: 1·2·4·5·9·10·11·13·17·18·19·21·23·27·29·32·34 중 하나라도 미충족 시 배포 불가.

---

## 12. 범위

**v1 필수**
다이얼 드래그 설정 + 놓으면 자동 시작 / 게이지 2종(sector·segments) / 분 단위 표시(마지막 1분만 초) / 테마 6종 / 일시정지·리셋·±1분 / 프리셋 버튼 / 키보드·숫자 입력 / 알람 3초·30초 + 음량 3단계 + 화면 점멸 / 오디오 클럭 예약 + 재언락 / 하이브리드 클럭 / 장시간 부재 배너 / 다중 탭 리더 선출 / paused 복원 / 접근성 전체 / dailyCounts 스키마 / 알람 미리 듣기

**v1 사이클 모드 (옵션)**
50/10/30/3 기본, 25/5/15/4 프리셋, 자동진행 토글 2개, 건너뛰기

**v1.1 이후**
60분 초과(최대 11:59), 5초 단위 정밀 모드, 파비콘 진행률, 주간 통계 UI, Document Picture-in-Picture(물리 제품의 "항상 보임"을 되찾는 유일한 웹 수단), Wake Lock, 작업 라벨

---

## 13. 제출 형식

11절 39개 항목 각각에 **☐ 통과 / 검증 방법 / 실제 관측값**을 기재한다.
"구현했다"가 아니라 **"어떻게 확인했는지"**를 증거와 함께 보고한다. 미검증 항목은 README "Known limitations"에 정직하게 명시한다.
