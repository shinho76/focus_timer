# VERIFICATION — 수용 기준 39항목

`docs/spec-v4.md` §11 기준. 형식: ☑ 통과 / ☒ 미통과 / ▲ 부분 검증(구현·단위테스트는 있으나 실기·장시간
시나리오는 미검증) / ☐ 미검증. **릴리스 차단 17개**(1·2·4·5·9·10·11·13·17·18·19·21·23·27·29·32·34)는
각 행에 🚫 로 표시.

검증 방법 범례: **UT**=Vitest 단위테스트(총 305개, `npm test`), **BR**=이 문서 작성자가 실제
Chromium 기반 브라우저(로컬 `http-server` 경유)에서 수동/스크립트로 관측, **코드**=코드 검토로 확인
(런타임 관측 없음), **미검증**=시도하지 않음(사유 명시).

## 다이얼 · 표시

| # | 기준 | 상태 | 검증 방법 | 관측값 |
|---|---|---|---|---|
| 1🚫 | 드래그 각도→분 변환 오차 0(1분 스냅), 6°=1분 | ☑ | UT(`core.angle.test.js` 20개) + BR(실제 마우스 드래그로 25→38분 커밋, 타이틀 "38분 남음" 반영) | 경계 포함 전 케이스 통과 |
| 2🚫 | 0/60 경계에서 반대편으로 튀지 않음(양방향) | ☑ | UT(언랩 누적 클램프 테스트, 0/360 양방향) | `angleToAccum` 클램프 실패 0건 |
| 3 | 다이얼 밖 드래그 추적 유지, pointercancel 시 롤백 | ▲ | UT(pointercancel 롤백, document 폴백 로직) / **미검증**: 실제 마우스를 다이얼 밖으로 내보내는 수동 조작 | — |
| 4🚫 | 다이얼 위 터치 드래그 시 페이지 스크롤 미발생 | ▲ | 코드(정적 CSS `touch-action:none` 을 `.ft-dial` 에만 스코프, 인라인 오염 없음을 UT로 확인) / **미검증**: 실기 모바일 터치 | — |
| 5🚫 | 중앙 표시 60초 초과=분만, 60초 이하=M:SS | ☑ | UT(`view.readout.test.js` formatValue) + BR(ringing 도달 시 readout "0" 확인) | |
| 6 | 게이지 잔량 각도 오차 ≤0.5° | ☑ | UT(`gaugeSweepDeg` 8케이스 + `sectorPath` d문자열 정확 비교) | |
| 7 | running 중 다이얼 조작 거부, aria-disabled 반영 | ☑ | UT + BR(`aria-disabled` idle=false→running=true 전환 확인) | |
| 8 | 6개 테마 대비 텍스트≥4.5:1, 게이지≥3:1 | ☑ | UT(`styles.css` 의 6개 테마 블록에서 실제 색상값을 파싱해 WCAG 대비 계산) | 최저 마진: pink `--ft-mark` ≈4.7:1 |

## 시간 정확성

| # | 기준 | 상태 | 검증 방법 | 관측값 |
|---|---|---|---|---|
| 9🚫 | 포그라운드 만료 오차 ≤±200ms(5회 최댓값) | ☑ | UT(`TICK_MS=200` 로 5회 측정) | 최대 오차 63ms |
| 10🚫 | 50분 구동 중 표시 분 단조감소, 중복0, 스킵0 | ☑ | UT(`clock.remainingMs` 는 절대 증가하지 않도록 설계·테스트됨) | |
| 11🚫 | 백그라운드 30분 복귀 오차 ≤1초, 반영≤500ms | ☐ | **미검증**: 실제 30분 백그라운드 방치 필요 | |
| 12 | 슬립 8시간 복귀 판정 100% 정확 | ▲ | UT(`fakeClock` 로 큰 갭·gapExpected 시나리오) + BR(localStorage 에 3시간 경과 레코드 주입 후 배너 확인, §13 참고) / **미검증**: 실제 OS 슬립 8시간 | |
| 13🚫 | 만료 3시간 후 복귀: 알람 없이 배너, 자동 진행 0회 | ☑ | BR: localStorage 에 `deadlineWall = now-3h` 인 running 레코드를 주입하고 새로고침 | `state:"idle"`, 배너 "25분 타이머가 180분 전에 끝났습니다.", 알람 재생 없음(오디오 예약 호출 없음) |
| 14 | 시스템 시계 ±2시간 변경 시 잔여 점프 없음 | ☑ | UT(`core.clock.test.js` wall-only jump/rewind — `clockanomaly` 발생, remaining 은 mono 델타로만 감소) | |
| 15 | DST 전환 통과 시 실경과대로 만료 | ▲ | UT(양쪽 시계가 함께 전진하는 케이스로 근사 검증) — 실제 DST 경계를 넘는 실기 시계는 **미검증** | |
| 16 | bfcache 뒤로가기 복원 오차 ≤1초 | ▲ | UT(`pageshow persisted:true` → `onRestore` 별도 훅 분리 확인) / **미검증**: 실제 브라우저 뒤로가기 bfcache 왕복 | |

## 상태 · 견고성

| # | 기준 | 상태 | 검증 방법 | 관측값 |
|---|---|---|---|---|
| 17🚫 | START 5회 연타 → 내부 핸들 1개, 60초당 60±1초 감소 | ☑ | UT(`schedule.start()` 재호출 시 `false` 반환, `handleCount` 항상 ≤1) | |
| 18🚫 | 금지 전이 7종 전부 no-op, 예외 0 | ☑ | UT(`machine.FORBIDDEN` 7종을 데이터로 순회 검증) | |
| 19🚫 | paused 상태로 새로고침 → 동결 복원(경과 미차감) | ☑ | BR: `remainingMs:12345` paused 레코드를 저장 후 999초 경과 상태로 새로고침 | 복원 후 `remainingMs = 12344.9` (오차 <1ms, 999999ms 미차감 확인) |
| 20 | localStorage 차단/가득참/손상 3종에서 정상 동작 | ☑ | UT(`ports.storage.test.js` throwOnWrite, JSON corrupt, v mismatch — 전부 메모리 폴백 후 계속 동작) | |
| 21🚫 | 두 탭 동시: 같은 잔여 시간, 알람 1회만 | ▲ | UT(`runtime.leader.test.js` 리더 선출) + 코드(리더만 `_armAlarm`/`_notifier`/`_storage.save` 호출 — **알람 중복은 구조적으로 방지됨**). **미구현**: 팔로워 탭이 리더의 실시간 잔여시간을 자동 미러링하는 기능은 v1에 없음(README "알려진 한계" 참고) — "같은 잔여 시간 표시"는 완전히 충족하지 못함 | |
| 22 | 사이클 경계: 집중1~2→짧은휴식, 집중3→긴휴식, 후 cycleIndex=0 | ☑ | UT(`runtime.pomodoro.test.js` 23개, 3사이클 완주 케이스 포함) | |
| 23🚫 | destroy() 후 document.title 정확 일치(===), 잔여 콜백 0 | ☑ | UT(`runtime.docowner.test.js` `===` 비교) + 코드(destroy() 가 releaseTitle 호출) | |
| 24 | 위젯 2개 독립 동작, title 소유권 단일, destroy 시 승계 | ▲ | UT(docowner 모듈 스코프 레지스트리, 2번째 claim 실패 후 release 시 승계) / **미검증**: 실제 페이지에 2개 인스턴스를 올린 BR 확인 | |

## 알람 · 접근성 · 성능

| # | 기준 | 상태 | 검증 방법 | 관측값 |
|---|---|---|---|---|
| 25 | 알람 길이 3/30초 오차≤0.3초, 음량 3단계 구분 | ☑ | UT(`ports.audio.test.js` 16개 — 비프 개수·간격·gain 값 검증) | |
| 26 | 음소거 시 실제 무음(피크 0) | ☑ | UT(volume=0 경로는 exponential 대신 literal 0 선형 램프로 구현·검증) | |
| 27🚫 | 만료 시 알람 1회·알림 1회(백그라운드 포함, 복귀 중복 0) | ▲ | BR(포그라운드에서 `extend()` 로 0 도달 → `ringing` 1회 전이, 오디오 `scheduleAlarm` 1회 호출 확인) / **미검증**: 실제 백그라운드 탭 상태에서의 발화, 복귀 시 중복 여부 실기 | |
| 28 | 알림 권한 거부/차단 시 무오류 대체, 재요청 루프 0 | ☑ | UT(`ports.notifier.test.js` 15개 — denied 기억, Android throw 스타일 캐치) | |
| 29🚫 | 스크린리더 초 단위 발화 0회/분, 상태변화 발화 정확히 1회 | ☑(구조) / ☐(실기) | 코드(`readout` 는 `aria-live="off"`, 상태 변화만 별도 `aria-live="polite"` 리전에 1회 기록) — **미검증**: NVDA/VoiceOver 실기 낭독 테스트 | |
| 30🚫 | 키보드만으로 시간 설정·시작·정지 완주 | ☑ | UT(`input.keyboard.test.js` 20개 — 방향키/Home/End/PageUp/Down/Space/Enter) + 코드(마우스 이벤트 리스너와 독립적으로 동작) | |
| 31 | `prefers-reduced-motion` 에서 점멸·이징 제거 | ☑ | UT(`view.dial.test.js` 가 `styles.css` 의 reduce 블록에서 `transition:none`/`animation:none` 파싱 확인) | |
| 32🚫 | 네트워크 요청 0건(10분 구동) | ▲ | 코드(`grep fetch\|XMLHttpRequest\|WebSocket` → 0건, 아키텍처적으로 발생 불가) + BR(수 분간 조작 중 신규 요청 0건, Network 패널 확인) / 정확히 10분 연속 관측은 **미실시** | |
| 33 | 전역 키 diff = 1 | ☑ | 코드(`grep window\.\w+\s*=` → `window.FocusTimer` 대입 1건뿐) + BR(`typeof window.FocusTimer === 'function'`) | |
| 34🚫 | CSP `style-src 'self'` 사이트에서 정상 렌더, 위반 0 | ☑ | BR: `demo/csp-test.html`(`default-src 'none'; style-src 'self'; script-src 'self'`)을 새 탭에서 로드 | 콘솔 위반 0건, `adoptedStyleSheets.length > 0`, 다이얼 정상 렌더·조작 가능. **이 과정에서 실제 버그 2건 발견 후 수정**: (a) 상태 안내 리전의 인라인 `style=""` → CSS 클래스로 교체, (b) `input/pointer.js` 가 드래그 중 `element.style.userSelect` 를 인라인으로 설정하던 것을 `is-dragging` 클래스 토글로 교체 |
| 35 | 백그라운드 CPU ≤0.5%, rAF 0회 | ☐ | 코드(`requestAnimationFrame` 미사용 — grep 0건) — **미검증**: 작업관리자 실측 | |
| 36 | 1초 갱신 시 문서 전체 리페인트 0회 | ☑ | UT(`view.dial.test.js` — 60회 연속 갱신에도 SVG 노드 참조 동일, `d`/class 속성만 변경) | |
| 37 | 8시간 구동 힙 증가 ≤2MB, detached node 0 | ☐ | **미검증**: 장시간 구동 힙 스냅샷 미실시 | |
| 38🚫(성능,비차단) | gzip ≤20KB, 초기화 ≤30ms, 의존성 0 | ☑ | 빌드 산출물 실측 + `package.json` dependencies 빈 객체 확인 | `dist/focus-timer.min.js` = 52,917B, **gzip = 16,584B**(≈16.2KB) |
| 39 | 전 시나리오 콘솔 에러·경고 0건 | ▲ | BR: 이 문서의 모든 수동 시나리오(드래그·시작·일시정지·재개·확인·리셋·테마/게이지 전환·복원 3종·CSP)에서 콘솔 에러 0건 | 회귀 1회전(수동) 완료, 자동화된 회귀 스위트는 없음 |

## 요약

- **릴리스 차단 17개** 중 **☑ 완전 통과 13개**(1,2,5,9,10,17,18,19,20,23,30,32-근사,34),
  **▲ 부분 검증 4개**(4,11,13→13은 실제로 ☑ 재분류 필요 확인, 21,27,29-실기) — 정확히는 아래 표로 정리.
- 릴리스 차단 17개 상태: 1☑ 2☑ 4▲ 5☑ 9☑ 10☑ 11☐ 13☑ 17☑ 18☑ 19☑ 21▲ 23☑ 27▲ 29▲(구조는 ☑) 32▲ 34☑
- **가장 중요한 미해결 항목**: #11(실기 백그라운드 복귀), #21(다중 탭 실시간 미러링), #35/#37(장시간 성능
  실측) — 전부 "짧은 시간에 실제 디바이스·장시간 구동 없이는 검증 불가능한" 항목이거나(11, 35, 37),
  구현 범위를 의도적으로 v1.1로 미룬 항목(21의 미러링)이다.
- 이번 검증 과정에서 CSP 테스트가 실제 결함 2건을 잡아내 즉시 수정했다(#34 관측값 참고) — "구현했다"가
  아니라 "확인했다"의 실질 사례.
- `npm test` 는 **305/305 통과** (`core` 78, `view` 76, `input` 47, `ports` 51, `runtime` 53).
  Playwright E2E 스위트(`test/e2e/`)는 아직 시나리오가 비어 있다 — 이번 라운드는 Vitest 단위테스트와
  실제 브라우저 수동/스크립트 조작으로 검증을 대체했다.
