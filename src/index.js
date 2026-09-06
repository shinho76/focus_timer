/**
 * <focus-timer> — 통합 조립 (index.js). 다른 워크스트림이 만든 core/ports/view/input/runtime
 * 를 여기서만 서로 연결한다 (CLAUDE.md: 이 파일은 "integration" 소유).
 *
 * 흐름: idle → (다이얼 드래그) → setting → (손을 떼면) running → 0 도달 → ringing → acknowledge → idle
 */

import { createClock } from './core/clock.js';
import { createSchedule } from './core/schedule.js';
import { createMachine } from './core/machine.js';
import { snapMinutes } from './core/angle.js';

import { createAudioPort } from './ports/audio.js';
import { createStoragePort } from './ports/storage.js';
import { createNotifierPort } from './ports/notifier.js';

import { renderDial, applyStyles, resetDial } from './view/dial.js';
import { renderReadout, resetReadout } from './view/readout.js';
import CSS_TEXT from './view/styles.css';

import { attachPointer } from './input/pointer.js';
import {
  attachKeyboard,
  attachPreset,
  attachDelta,
  attachNumberInput,
  PRESET_MINUTES,
  DELTA_STEPS,
} from './input/keyboard.js';

import { attachLifecycle } from './runtime/lifecycle.js';
import { createLeaderElection } from './runtime/leader.js';
import { claimTitle, releaseTitle, setTitle } from './runtime/docowner.js';
import { createPomodoro, POMODORO_PRESETS } from './modes/pomodoro.js';

const GRACE_MS = 90_000;
let seq = 0;

/** 6개 테마(spec §3.1) — 스와치 버튼과 aria-label 에 쓴다. 실제 색상은
 * view/styles.css 의 `:host([theme="..."])` 블록·`.ft-swatch--*` 클래스가 정의한다. */
const THEMES = [
  { id: 'auto', label: '자동' },
  { id: 'classic', label: '클래식' },
  { id: 'purple', label: '퍼플' },
  { id: 'pink', label: '핑크' },
  { id: 'sky', label: '스카이' },
  { id: 'dark', label: '다크' },
];

/** 게이지 스타일 2종 — segments(60분할 세그먼트) / sector(연속 부채꼴="파이 차트"). */
const GAUGE_STYLES = [
  { id: 'segments', label: '세그먼트' },
  { id: 'sector', label: '파이 차트' },
];

/**
 * 시간의 중요함을 일깨우는 명언 20선 — 웹 검색으로 실제 널리 알려진 출처를
 * 확인해 고른 것들이다(벤저민 프랭클린, 세네카, 톨스토이, 스티브 잡스,
 * 피터 드러커 등). 정확한 원저자를 확인할 수 없는 두 항목은 "속담"으로
 * 표기했다. 1분마다 하나씩 순환한다(디자인 요청).
 * @type {{text: string, author: string}[]}
 */
const TIME_QUOTES = [
  { text: '시간은 금이다.', author: '벤저민 프랭클린' },
  { text: '오늘 할 수 있는 일을 내일로 미루지 마라.', author: '벤저민 프랭클린' },
  { text: '잃어버린 시간은 다시 찾을 수 없다.', author: '벤저민 프랭클린' },
  { text: '인생을 사랑한다면 시간을 낭비하지 마라, 인생은 시간으로 이루어져 있으니.', author: '벤저민 프랭클린' },
  { text: '내일 두 개보다 오늘 하나가 낫다.', author: '벤저민 프랭클린' },
  { text: '시간이 가장 소중하다면, 시간을 낭비하는 것이 가장 큰 사치다.', author: '벤저민 프랭클린' },
  { text: '급하게 서두르면 큰 낭비를 부른다, 모든 일에 시간을 들여라.', author: '벤저민 프랭클린' },
  { text: '우리에게 짧은 삶이 주어진 게 아니라, 우리가 삶을 짧게 만드는 것이다.', author: '세네카' },
  { text: '시간을 아낄 줄 알면 인생은 길다.', author: '세네카' },
  { text: '사람들은 재산은 아끼면서 정작 시간은 함부로 낭비한다.', author: '세네카' },
  { text: '시간이 지나야 진실이 드러난다.', author: '세네카' },
  { text: '시간은 인간이 쓸 수 있는 가장 값진 것이다.', author: '속담' },
  { text: '지금 이 순간이 가장 중요하다, 우리에게 힘이 있는 유일한 때이므로.', author: '레프 톨스토이' },
  { text: '일하는 시간과 노는 시간을 뚜렷이 구분하고, 매 순간을 유용하게 써라.', author: '루이자 메이 올콧' },
  { text: '당신의 시간은 한정되어 있다, 다른 사람의 삶을 사느라 낭비하지 마라.', author: '스티브 잡스' },
  { text: '시간을 지배하는 법을 배우면, 인생을 지배하게 된다.', author: '속담' },
  { text: '어제는 지나갔고 내일은 오지 않았다, 우리에게는 오늘만 있다.', author: '틱낫한' },
  { text: '시간은 우리가 가장 원하지만 가장 함부로 쓰는 것이다.', author: '윌리엄 펜' },
  { text: '세월은 사람을 기다려주지 않는다.', author: '옛 속담' },
  {
    text: '시간은 가장 희소한 자원이다, 이를 관리하지 못하면 다른 무엇도 관리할 수 없다.',
    author: '피터 드러커',
  },
];

/** Real browser time port. `Date.now`/`performance.now` live ONLY here. */
function realPort() {
  return {
    wall: () => Date.now(),
    mono: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * 게이지 스타일 세그먼트 버튼용 미니 아이콘. 텍스트 라벨 없이 모양만으로
 * 구분한다: segments = "띠 모양"(점선 링), sector = "속이 균일한 색"(꽉 찬 원).
 * @param {'segments'|'sector'} kind
 * @returns {SVGElement}
 */
function buildGaugeIcon(kind) {
  const svg = svgEl('svg', {
    class: 'ft-gauge-icon',
    viewBox: '0 0 20 20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  if (kind === 'sector') {
    svg.append(svgEl('circle', { cx: 10, cy: 10, r: 7, fill: 'currentColor' }));
  } else {
    svg.append(
      svgEl('circle', {
        cx: 10,
        cy: 10,
        r: 7,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 4,
        'stroke-dasharray': '3.2 2.6',
      }),
    );
  }
  return svg;
}

/** 목표 입력 플로팅 버튼용 "+" 아이콘. 목표가 이미 있으면 CSS 로 회전시켜 "×"(닫기)처럼 보이게 한다. */
function buildPlusIcon() {
  const svg = svgEl('svg', {
    class: 'ft-fab-icon',
    viewBox: '0 0 20 20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(svgEl('line', { x1: 10, y1: 3, x2: 10, y2: 17, stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
  svg.append(svgEl('line', { x1: 3, y1: 10, x2: 17, y2: 10, stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
  return svg;
}

/** 설정(테마/게이지/리셋/알람 미리듣기) 토글용 톱니 아이콘 — 저빈도 기능을 한데 묶어
 * 아이콘 하나 뒤로 숨긴다(디자인 종합의견 반영: 상시 노출 컨트롤 수 축소). */
function buildGearIcon() {
  const svg = svgEl('svg', {
    class: 'ft-fab-icon',
    viewBox: '0 0 20 20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(svgEl('circle', { cx: 10, cy: 10, r: 3.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
  for (let deg = 0; deg < 360; deg += 60) {
    const rad = (deg * Math.PI) / 180;
    svg.append(
      svgEl('line', {
        x1: 10 + Math.cos(rad) * 5.4,
        y1: 10 + Math.sin(rad) * 5.4,
        x2: 10 + Math.cos(rad) * 8,
        y2: 10 + Math.sin(rad) * 8,
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
      }),
    );
  }
  return svg;
}

/** "미세 조정" 플로팅 버튼용 슬라이더(이퀄라이저) 아이콘 — ±조정을 은유한다. */
function buildSlidersIcon() {
  const svg = svgEl('svg', {
    class: 'ft-fab-icon',
    viewBox: '0 0 20 20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(svgEl('line', { x1: 3, y1: 7, x2: 17, y2: 7, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  svg.append(svgEl('circle', { cx: 8, cy: 7, r: 2.2, fill: 'currentColor' }));
  svg.append(svgEl('line', { x1: 3, y1: 13, x2: 17, y2: 13, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  svg.append(svgEl('circle', { cx: 13, cy: 13, r: 2.2, fill: 'currentColor' }));
  return svg;
}

class FocusTimer extends HTMLElement {
  static get observedAttributes() {
    return ['theme', 'gauge', 'volume', 'alarm-length', 'flash', 'notify'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._instanceId = `ft-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    this._destroyed = false;
    this._unsubs = [];
    this._selectedMinutes = 0;
    this._totalMs = 0;
    this._pomodoro = null;
  }

  // ---- 공개 읽기 전용 속성 (spec §10) --------------------------------------
  get state() {
    return this._machine ? this._machine.state : 'idle';
  }
  get mode() {
    return this._cfg ? this._cfg.mode : 'simple';
  }
  get phase() {
    return this._pomodoro ? this._pomodoro.phase : 'focus';
  }
  get remainingMs() {
    return this._schedule ? this._schedule.remainingMs : 0;
  }
  get totalMs() {
    return this._totalMs;
  }
  get progress() {
    return this._totalMs > 0 ? Math.max(0, Math.min(1, this.remainingMs / this._totalMs)) : 1;
  }
  get cycleIndex() {
    return this._pomodoro ? this._pomodoro.cycleIndex : 0;
  }
  get completedToday() {
    return this._completedToday || 0;
  }
  get isLeader() {
    return this._leader ? this._leader.isLeader : true;
  }
  get capabilities() {
    return {
      audio: typeof (window.AudioContext || window.webkitAudioContext) === 'function',
      notification: typeof window.Notification === 'function',
      wakeLock: 'wakeLock' in navigator,
      locks: !!(navigator.locks && typeof navigator.locks.request === 'function'),
      persist: this._storage ? this._storage.isPersisted : false,
    };
  }

  // ---- lifecycle ------------------------------------------------------------
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._readConfig();
    this._buildPorts();
    this._buildCore();
    this._buildShadow();
    this._wireInput();
    this._wireRuntime();
    this._wireGoal();
    this._restoreOrInit();
    this._restoreGoal();
    this._startClockDisplay();
    this._startQuoteRotator();
    this._render();
  }

  disconnectedCallback() {
    this.destroy();
  }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._built || oldV === newV) return;
    if (name === 'gauge') this._cfg.gauge = newV === 'segments' ? 'segments' : 'sector';
    if (name === 'theme' || name === 'gauge') this._render();
    if (name === 'volume') this._cfg.volume = this._parseVolume(newV);
    if (name === 'alarm-length') this._cfg.alarmLength = Number(newV) || this._cfg.alarmLength;
    if (name === 'flash') this._cfg.flash = newV !== 'off';
    if (name === 'notify') this._cfg.notify = newV === 'on';
  }

  // ---- 설정 ------------------------------------------------------------------
  _readConfig() {
    const attr = (name, def) => (this.hasAttribute(name) ? this.getAttribute(name) : def);
    this._cfg = {
      mode: attr('mode', 'simple') === 'pomodoro' ? 'pomodoro' : 'simple',
      gauge: attr('gauge', 'sector') === 'segments' ? 'segments' : 'sector',
      maxMinutes: Math.max(1, Number(attr('max-minutes', 60)) || 60),
      defaultMinutes: Math.max(1, Number(attr('default-minutes', 50)) || 50),
      autostartOnRelease: attr('autostart-on-release', 'on') !== 'off',
      alarmLength: Number(attr('alarm-length', 30)) === 3 ? 3 : 30,
      volume: this._parseVolume(attr('volume', '0.35')),
      flash: attr('flash', 'on') !== 'off',
      notify: attr('notify', 'off') === 'on',
      titleSync: attr('title-sync', 'running') !== 'off',
      persist: attr('persist', 'local') !== 'off',
      storageKey: attr('storage-key', 'focus-timer.v1'),
      lang: attr('lang', 'ko'),
    };
    this._selectedMinutes = this._cfg.defaultMinutes;
  }

  _parseVolume(raw) {
    const n = Number(raw);
    if (n <= 0) return 0;
    if (n >= 0.6) return 0.8;
    if (n >= 0.2) return 0.35;
    return n === 0.35 || n === 0.8 ? n : 0.35;
  }

  // ---- 포트/코어 조립 ----------------------------------------------------------
  _buildPorts() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    this._audio = createAudioPort(AudioCtor);
    this._notifier = createNotifierPort(window.Notification, window);
    this._storage = this._cfg.persist
      ? createStoragePort(window.localStorage, `${this._cfg.storageKey}:record`, {
          now: () => Date.now(),
        })
      : null;
    if (this._storage) {
      this._storage.onPersistenceLost(() => {
        this._persistenceNoticeShown = true;
        this._render();
      });
    }
    // 목표 텍스트는 타이머 진행 상태(§7.1 스키마)와 무관한 별도 설정이라
    // 독립된 키를 쓴다 — persist="off" 여도 목표 자체는 남기고 싶을 수
    // 있으니(사용자가 별도 요청하지 않는 한) 항상 켠다.
    this._goalStorage = createStoragePort(window.localStorage, `${this._cfg.storageKey}:goal`);
  }

  _buildCore() {
    this._port = realPort();
    this._clock = createClock(this._port);
    this._schedule = createSchedule(this._clock);
    this._machine = createMachine('idle');

    this._unsubs.push(
      this._machine.on('statechange', (change) => {
        this._dispatch('ft:statechange', change);
      }),
    );
    this._unsubs.push(
      this._clock.on('tick', ({ remainingMs }) => {
        this._dispatch('ft:tick', { remainingMs, totalMs: this._totalMs });
        this._render();
        this._maybeSave();
        this._broadcastSync();
      }),
    );
    this._unsubs.push(
      this._clock.on('clockanomaly', (detail) => this._dispatch('ft:clockanomaly', detail)),
    );
    this._unsubs.push(this._clock.on('expire', () => this._onExpire()));

    if (this._cfg.mode === 'pomodoro') {
      this._pomodoro = createPomodoro(this._schedule, this._readPomodoroConfig());
    }
  }

  _readPomodoroConfig() {
    const attr = (name) => (this.hasAttribute(name) ? this.getAttribute(name) : undefined);
    const preset = attr('pomodoro-preset');
    return {
      preset: preset && POMODORO_PRESETS[preset] ? preset : undefined,
    };
  }

  // ---- shadow DOM --------------------------------------------------------------
  /**
   * 화면 단순화(디자인 종합의견 반영, v1.2): "항상 전부 노출" 대신 우선순위를
   * 나눴다 — ①다이얼(히어로, 확대) ②프리셋+시작(1티어 상시 노출) ③미세조정(±,
   * 숫자입력 — 토글로 접힘) ④목표 입력 + 설정(테마/게이지/리셋/미리듣기 — 저빈도라
   * 아이콘 뒤로 숨김) ⑤날짜/시각/명언(부가 정보 — 맨 아래, 옅은 톤). 기존 기능은
   * 하나도 빼지 않고 노출 우선순위만 재배치했다.
   */
  _buildShadow() {
    applyStyles(this.shadowRoot, CSS_TEXT);

    const widget = el('div', { class: 'ft-widget', part: 'controls' });

    // 목표 텍스트 — 다이얼(시간) 바로 위, 설정돼 있을 때만 보인다. 히어로
    // 영역의 일부로 취급해 최상단에 둔다(입력 UI는 하단 유틸리티 바로 이동).
    this._goalTextEl = el('p', { class: 'ft-goal-text', hidden: '' });
    widget.append(this._goalTextEl);

    // 다이얼과 리드아웃을 별도의 위치기준 상자(.ft-stage)로 묶는다 — 리드아웃의
    // `position:absolute; inset:0` 은 이 상자를 기준으로 삼아야 다이얼 위에
    // 정확히 겹친다. 위젯(.ft-widget) 자체를 기준으로 삼으면 그 아래 컨트롤/
    // 옵션 영역까지 포함한 전체 높이의 중앙에 텍스트가 떠서, 컨트롤이 늘어날
    // 때마다 다이얼과 어긋난다.
    const stage = el('div', { class: 'ft-stage' });
    this._dialContainer = el('div');
    stage.append(this._dialContainer);

    this._readoutContainer = el('div');
    stage.append(this._readoutContainer);

    // 시계 중앙(허브)을 누르면 시작/일시정지/재개/확인이 되는 지름길 —
    // 배경이 투명해 그 아래(readoutContainer)의 시간 텍스트가 그대로
    // 비쳐 보인다("버튼을 시간과 함께 보이도록" 요청). 허브 크기(다이얼
    // 지름의 50%)에 맞춰 중앙에 배치했다. 다이얼 드래그(pointer.js)는
    // .ft-dial 에 붙어 있고 이 버튼은 stage 의 나중 자식이라 위에 그려져,
    // 중앙을 누르면 드래그가 아니라 이 버튼이 클릭을 가져간다.
    this._centerStartBtn = el('button', {
      type: 'button',
      class: 'ft-center-start',
      'aria-label': '시작',
    });
    stage.append(this._centerStartBtn);
    widget.append(stage);

    this._liveRegion = el('div', {
      'aria-live': 'polite',
      class: 'ft-sr-only',
    });
    widget.append(this._liveRegion);

    this._banner = el('div', { class: 'ft-banner', hidden: '' });
    widget.append(this._banner);

    const controls = el('div', { class: 'ft-controls', part: 'controls' });

    // 프리셋은 5~60분 7종을 세그먼트 버튼(한 줄로 이어붙인 버튼 묶음)으로 —
    // 개별 알약 버튼이 아니라 "여러 선택지 중 하나"라는 게 한눈에 보이도록.
    const presetGroup = el('div', {
      class: 'ft-segmented',
      role: 'group',
      'aria-label': '프리셋 시간(분)',
    });
    this._presetButtons = PRESET_MINUTES.map((m) =>
      el('button', { type: 'button', class: 'ft-segmented__item', 'data-minutes': String(m) }, String(m)),
    );
    this._presetButtons.forEach((b) => presetGroup.append(b));
    controls.append(presetGroup);

    // 전송(transport) 버튼 — 카세트 플레이어처럼 이모지 아이콘 한 줄, 동일한
    // 크기로 나란히(사용자 요청). 시작/일시정지/재개/확인은 상태에 따라 같은
    // 버튼의 아이콘·aria-label 만 바뀐다(_render 참고). 리셋은 "저빈도 설정"이
    // 아니라 실행/일시정지 중인 타이머를 즉시 되돌리는 상시 필요한 복구
    // 동작이다 — 예전 라운드에서 설정 패널 안에 넣어뒀더니 "다시 찾기
    // 어렵다"는 피드백을 받아 시작 버튼 옆 상시 노출 위치로 옮겨져 있었다.
    const transportRow = el('div', { class: 'ft-transport' });
    this._primaryBtn = el(
      'button',
      { type: 'button', part: 'pause-button', class: 'ft-transport-btn', 'aria-label': '시작' },
      '▶️',
    );
    this._resetBtn = el(
      'button',
      { type: 'button', class: 'ft-transport-btn ft-transport-btn--ghost', 'aria-label': '리셋' },
      '⏮️',
    );
    transportRow.append(this._primaryBtn, this._resetBtn);
    controls.append(transportRow);

    this._finetunePanel = el('div', { class: 'ft-finetune', hidden: '' });

    this._deltaButtons = DELTA_STEPS.map((d) =>
      el('button', { type: 'button', 'data-delta': String(d) }, d > 0 ? `+${d}` : String(d)),
    );
    this._deltaButtons.forEach((b) => this._finetunePanel.append(b));

    this._numberInput = el('input', {
      type: 'number',
      min: '1',
      max: String(this._cfg.maxMinutes),
      'aria-label': '분 직접 입력',
    });
    this._finetunePanel.append(this._numberInput);
    controls.append(this._finetunePanel);

    widget.append(controls);

    // 유틸리티 바 — 미세 조정(±) · 목표 입력(+) · 설정(톱니), 전부 저빈도
    // 진입점만 아이콘 버튼으로 상시 노출한다. 아이콘만으로는 처음 보는
    // 사용자가 기능을 추측할 수 없다는 지적(디자인 종합의견) — 아이콘
    // 버튼마다 짧은 캡션을 붙인다. 목표는 자주 쓰는 진입점이라 액센트색
    // (.ft-fab) 그대로, 나머지는 저빈도라 중립색(--muted)으로 우선순위를
    // 색으로도 구분했다.
    const utilityRow = el('div', { class: 'ft-utility-row' });

    // "미세 조정"(±버튼·숫자입력) — 사용자 요청으로 컨트롤 줄의 텍스트+쉐브론
    // 토글에서 "+" 버튼 앞에 오는 플로팅(FAB) 버튼으로 옮겼다. 프리셋만으로는
    // 부족한 미세 조정을 위한 것이라 여전히 접혀 있다가 펼쳐진다.
    this._finetuneToggle = el(
      'button',
      {
        type: 'button',
        class: 'ft-fab ft-fab--muted',
        'aria-expanded': 'false',
        'aria-label': '미세 조정 펼치기',
      },
      buildSlidersIcon(),
    );
    const finetuneGroup = el(
      'div',
      { class: 'ft-fab-group' },
      this._finetuneToggle,
      el('span', { class: 'ft-fab-label', 'aria-hidden': 'true' }, '조정'),
    );

    this._goalInput = el('input', {
      type: 'text',
      class: 'ft-goal-input',
      maxlength: '60',
      placeholder: '오늘의 목표를 한 가지만 적어보세요',
      hidden: '',
      'aria-label': '오늘의 목표 입력',
    });
    this._goalFab = el(
      'button',
      { type: 'button', class: 'ft-fab', 'aria-label': '오늘의 목표 설정' },
      buildPlusIcon(),
    );
    const goalGroup = el(
      'div',
      { class: 'ft-fab-group' },
      this._goalFab,
      el('span', { class: 'ft-fab-label', 'aria-hidden': 'true' }, '목표'),
    );

    this._settingsToggle = el(
      'button',
      {
        type: 'button',
        class: 'ft-fab ft-fab--muted',
        'aria-expanded': 'false',
        'aria-label': '설정 펼치기',
      },
      buildGearIcon(),
    );
    const settingsGroup = el(
      'div',
      { class: 'ft-fab-group' },
      this._settingsToggle,
      el('span', { class: 'ft-fab-label', 'aria-hidden': 'true' }, '설정'),
    );

    utilityRow.append(this._goalInput, finetuneGroup, goalGroup, settingsGroup);
    widget.append(utilityRow);

    // 설정 패널 — 테마/게이지/알람 미리듣기처럼 매 세션 쓰지 않는 기능을 한데
    // 묶어 톱니 아이콘 뒤로 숨긴다. 리셋은 더 이상 여기 없다(위 참고 — 상시
    // 노출 위치로 이동).
    this._settingsPanel = el('div', { class: 'ft-settings-panel', hidden: '' });
    const settingsButtons = el('div', { class: 'ft-controls ft-controls--tight' });
    this._previewBtn = el('button', { type: 'button' }, '알람 미리 듣기');
    settingsButtons.append(this._previewBtn);
    this._settingsPanel.append(settingsButtons);
    this._settingsPanel.append(this._buildOptions());
    widget.append(this._settingsPanel);

    // 하단 부가 정보 — 날짜/시각 상태바 + 명언 로테이터. 핵심 과업(타이머)보다
    // 우선순위가 낮은 정보라 맨 아래, 옅은 톤으로 둔다.
    const secondary = el('div', { class: 'ft-secondary' });
    const statusBar = el('div', { class: 'ft-status' });
    this._dateEl = el('span', { class: 'ft-status-date' });
    this._clockEl = el('span', { class: 'ft-status-clock' });
    statusBar.append(this._dateEl, this._clockEl);
    secondary.append(statusBar);

    this._quoteBlock = el('div', { class: 'ft-quote' });
    this._quoteTextEl = el('p', { class: 'ft-quote-text' });
    this._quoteAuthorEl = el('p', { class: 'ft-quote-author' });
    this._quoteBlock.append(this._quoteTextEl, this._quoteAuthorEl);
    secondary.append(this._quoteBlock);
    widget.append(secondary);

    this.shadowRoot.append(widget);

    this._widget = widget;
  }

  /**
   * 디자인 개편(③④, 4차 개정): 6개 테마 × 2개 게이지 = 12조합 전부에 실시간으로
   * 닿을 수 있는 컨트롤. 텍스트 라벨 없이 색/아이콘만으로 구분하고(테마 =
   * 버튼 전체를 강조색으로, 게이지 = 점선 링/꽉 찬 원 아이콘), 두 그룹을 각각
   * 별도 줄에 두던 것을 사용자가 "너무 크다"고 지적해 한 줄에 작게 붙였다
   * (`.ft-segmented--compact` — 높이 1/3, 폭 절반 수준). 시각 장애 사용자를
   * 위한 이름은 `aria-label` 로만 남긴다.
   * @returns {HTMLElement}
   */
  _buildOptions() {
    const options = el('div', { class: 'ft-options', part: 'options' });
    const row = el('div', { class: 'ft-option-row ft-option-row--compact' });

    const themeGroup = el('div', {
      class: 'ft-segmented ft-segmented--compact',
      role: 'group',
      'aria-label': '테마',
    });
    this._themeButtons = THEMES.map(({ id, label }) => {
      const btn = el('button', {
        type: 'button',
        class: `ft-segmented__item ft-segmented__item--swatch ft-swatch--${id}`,
        'data-theme': id,
        'aria-label': `${label} 테마`,
        'aria-pressed': 'false',
      });
      themeGroup.append(btn);
      return btn;
    });
    row.append(themeGroup);

    const gaugeGroup = el('div', {
      class: 'ft-segmented ft-segmented--compact',
      role: 'group',
      'aria-label': '게이지 스타일',
    });
    this._gaugeButtons = GAUGE_STYLES.map(({ id, label }) => {
      const btn = el('button', {
        type: 'button',
        class: 'ft-segmented__item ft-segmented__item--icon',
        'data-gauge': id,
        'aria-label': label,
        'aria-pressed': 'false',
      });
      btn.append(buildGaugeIcon(id));
      gaugeGroup.append(btn);
      return btn;
    });
    row.append(gaugeGroup);

    options.append(row);
    return options;
  }

  // ---- 입력 배선 -----------------------------------------------------------------
  _wireInput() {
    const dialData = () => ({
      minutes:
        this._machine.state === 'idle' || this._machine.state === 'setting'
          ? this._selectedMinutes
          : Math.round(this._totalMs / 60000),
      maxMinutes: this._cfg.maxMinutes,
      progress: this._machine.state === 'idle' || this._machine.state === 'setting' ? 1 : this.progress,
      gauge: this._cfg.gauge,
      disabled: this._machine.state !== 'idle' && this._machine.state !== 'setting',
      unit: '분',
      label: '집중 시간',
      locale: this._cfg.lang,
    });

    this._dialEl = renderDial(this._dialContainer, dialData());

    this._pointer = attachPointer(this._dialEl, {
      minRadiusRatio: 0.2,
      minMinutes: 1,
      maxMinutes: this._cfg.maxMinutes,
      getMinutes: () => this._selectedMinutes,
      disabled: () => this._machine.state !== 'idle' && this._machine.state !== 'setting',
      onUnlockHint: () => this._audio.unlock(),
      onAngleChange: (minutes) => {
        if (this._machine.state === 'idle') this._machine.send('dialdown');
        this._selectedMinutes = minutes;
        this._dispatch('ft:set', { minutes });
        this._render();
      },
      onCommit: (minutes) => {
        // 사용자 피드백: "분침을 누르면 바로 시작되는데, 시간 변경만 하고
        // 시작 버튼을 눌러야 시작하게 해달라" — 다이얼 클릭/드래그는 값만
        // 정하고 절대 자동 시작하지 않는다(autostart-on-release 속성과
        // 무관하게, 다이얼에 한해 강제로 preview-only). 프리셋 버튼
        // (_setMinutesDirect)은 여전히 그 속성을 따른다 — "단발 결정"
        // 성격이 달라 예전 그대로 둔다.
        //
        // 다이얼 눈금 근처를 움직임 없이 클릭만 하고 뗀 경우(분침 근처 클릭 =
        // 즉시 그 시간으로 설정) pointermove 가 한 번도 없어 onAngleChange 가
        // idle→setting 전이를 못 시켰을 수 있다 — 여기서도 같은 보정을 해준다.
        if (this._machine.state === 'idle') this._machine.send('dialdown');
        this._selectedMinutes = minutes;
        this._dispatch('ft:set', { minutes });
        this._render();
      },
      onCancel: () => {
        if (this._machine.state === 'setting') this._machine.send('dialcancel');
        this._render();
      },
    });

    this._keyboard = attachKeyboard(this._dialEl, {
      min: 1,
      max: this._cfg.maxMinutes,
      disabled: () => this._machine.state !== 'idle' && this._machine.state !== 'setting',
      // 화살표/Home/End/PageUp/Down 은 전부 "연속 미세 조정" — 절대 자동시작하지
      // 않는다(_previewMinutes). 시작은 Space/Enter(onActivate→toggle) 또는
      // 프리셋 버튼처럼 명시적인 "단발 결정" 행동에서만 일어난다.
      onDelta: (d) => this._adjustMinutes(d),
      onSet: (m) => this._previewMinutes(m),
      onActivate: () => this.toggle(),
    });

    // 프리셋 버튼은 드래그 릴리스와 동등한 "단발 결정" — autostart 정책을 따른다.
    this._presetDetach = this._presetButtons.map((b) =>
      attachPreset(b, Number(b.dataset.minutes), (m) => this._setMinutesDirect(m)),
    );
    this._deltaDetach = this._deltaButtons.map((b) =>
      attachDelta(b, Number(b.dataset.delta), (d) => this._adjustMinutes(d)),
    );
    // 숫자 입력은 타이핑 중(input)에도 콜백이 오므로 미세 조정과 동일하게 다룬다
    // — 자릿수를 입력하는 도중에 자동시작되면 안 된다.
    this._numberDetach = attachNumberInput(this._numberInput, (m) => this._previewMinutes(m), {
      min: 1,
      max: this._cfg.maxMinutes,
    });

    this._onPrimary = () => this.toggle();
    this._primaryBtn.addEventListener('click', this._onPrimary);
    // 시계 중앙을 눌러도 시작/일시정지/재개/확인 — 같은 토글 핸들러를 공유한다
    // (사용자 요청: "시계 중앙에 설정된 시간을 클릭하면 시작하게 해줘").
    this._onCenterStart = () => this.toggle();
    this._centerStartBtn.addEventListener('click', this._onCenterStart);
    this._onReset = () => this.reset();
    this._resetBtn.addEventListener('click', this._onReset);
    this._onPreview = () => this._audio.previewAlarm(this._cfg.volume);
    this._previewBtn.addEventListener('click', this._onPreview);

    this._wireOptions();
    this._wireDisclosures();
  }

  /**
   * 상시 노출을 줄이려고 접어둔 두 패널(미세 조정 / 설정)의 펼침·접힘 토글만
   * 배선한다 — 안의 컨트롤 자체는 이미 각자 배선돼 있다(디자인 종합의견).
   */
  _wireDisclosures() {
    this._onFinetuneToggle = () => {
      const willShow = this._finetunePanel.hidden;
      this._finetunePanel.hidden = !willShow;
      this._finetuneToggle.setAttribute('aria-expanded', String(willShow));
    };
    this._finetuneToggle.addEventListener('click', this._onFinetuneToggle);

    this._onSettingsToggle = () => {
      const willShow = this._settingsPanel.hidden;
      this._settingsPanel.hidden = !willShow;
      this._settingsToggle.setAttribute('aria-expanded', String(willShow));
    };
    this._settingsToggle.addEventListener('click', this._onSettingsToggle);
  }

  /**
   * 테마 스와치 6개 + 게이지 토글 1개 배선(디자인 개편③④). 테마/게이지는
   * 다이얼 값이 아니라 순전히 겉모습이라 running 중에도 언제든 바꿀 수
   * 있다 — spec §3.4 의 "running 중 다이얼 조작 거부"와는 무관하다.
   */
  _wireOptions() {
    this._onThemeClick = (e) => {
      this.setAttribute('theme', e.currentTarget.dataset.theme);
    };
    this._themeButtons.forEach((b) => b.addEventListener('click', this._onThemeClick));

    this._onGaugeClick = (e) => {
      this.setAttribute('gauge', e.currentTarget.dataset.gauge);
    };
    this._gaugeButtons.forEach((b) => b.addEventListener('click', this._onGaugeClick));
  }

  // ---- 상단 상태바(날짜/시각) ------------------------------------------------------
  /** 오늘 날짜(YY.MM.DD)와 현재 시각(24시간, 분까지)을 1초마다 갱신한다.
   * 실제 벽시계 값은 이미 주입된 clock 포트(this._port.wall())로만 읽는다 —
   * index.js 안이라도 Date.now() 를 새로 흩뿌리지 않는다(realPort() 에만 있게). */
  _startClockDisplay() {
    const tick = () => {
      if (this._destroyed) return;
      const now = new Date(this._port.wall());
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      this._dateEl.textContent = `${yy}.${mm}.${dd}`;
      const hh = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      this._clockEl.textContent = `${hh}:${mi}`;
      this._clockTimerId = this._port.setTimeout(tick, 1000);
    };
    tick();
  }

  // ---- 명언 로테이터 ---------------------------------------------------------------
  /** TIME_QUOTES 를 1분 간격으로 순환 표시한다(디자인 요청). */
  _startQuoteRotator() {
    this._quoteIndex = Math.floor(Math.random() * TIME_QUOTES.length);
    const tick = () => {
      if (this._destroyed) return;
      const q = TIME_QUOTES[this._quoteIndex % TIME_QUOTES.length];
      this._quoteTextEl.textContent = `"${q.text}"`;
      this._quoteAuthorEl.textContent = `— ${q.author}`;
      this._quoteIndex += 1;
      this._quoteTimerId = this._port.setTimeout(tick, 60_000);
    };
    tick();
  }

  // ---- 목표 입력 --------------------------------------------------------------------
  /** 플로팅 버튼(+) → 인라인 입력 표시 → Enter/blur 로 저장, Escape 로 취소.
   * 목표는 "시간(다이얼) 위"의 별도 텍스트로 보여준다(디자인 요청). */
  _wireGoal() {
    this._onGoalFabClick = () => {
      if (this._goalInput.hidden) {
        this._goalInput.hidden = false;
        this._goalInput.value = this._goalText || '';
        this._goalInput.focus();
        this._goalInput.select();
      } else {
        this._goalInput.hidden = true;
      }
    };
    this._goalFab.addEventListener('click', this._onGoalFabClick);

    this._onGoalKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._commitGoal(this._goalInput.value);
        this._goalInput.hidden = true;
      } else if (e.key === 'Escape') {
        this._goalInput.hidden = true;
      }
    };
    this._goalInput.addEventListener('keydown', this._onGoalKeydown);

    this._onGoalBlur = () => {
      if (!this._goalInput.hidden) this._commitGoal(this._goalInput.value);
      this._goalInput.hidden = true;
    };
    this._goalInput.addEventListener('blur', this._onGoalBlur);
  }

  /** @param {string} text */
  _commitGoal(text) {
    const trimmed = (text || '').trim().slice(0, 60);
    this._goalText = trimmed;
    if (trimmed) {
      this._goalTextEl.textContent = trimmed;
      this._goalTextEl.hidden = false;
    } else {
      this._goalTextEl.textContent = '';
      this._goalTextEl.hidden = true;
    }
    if (this._goalStorage) {
      if (trimmed) this._goalStorage.save({ goal: trimmed });
      else this._goalStorage.clear();
    }
  }

  _restoreGoal() {
    if (!this._goalStorage) return;
    const rec = this._goalStorage.load();
    if (rec && typeof rec.goal === 'string' && rec.goal) {
      this._goalText = rec.goal;
      this._goalTextEl.textContent = rec.goal;
      this._goalTextEl.hidden = false;
    }
  }

  /**
   * "단발성 결정" 입력(프리셋 버튼 클릭)용 — 값을 커밋하고, 드래그를 놓았을 때와
   * 동등하게 autostart-on-release 정책을 따른다(spec §3.3 "동등한 병렬 수단").
   */
  _setMinutesDirect(minutes) {
    const state = this._machine.state;
    if (state !== 'idle' && state !== 'setting') return;
    if (state === 'idle') this._machine.send('dialdown');
    this._selectedMinutes = snapMinutes(minutes, 1);
    this._dispatch('ft:set', { minutes: this._selectedMinutes });
    if (this._cfg.autostartOnRelease && state === 'idle') {
      if (this._machine.send('dialup')) {
        this._startTimer(this._selectedMinutes);
        return;
      }
    }
    this._render();
  }

  /**
   * "연속 미세 조정" 입력(키보드 화살표/Home/End/PageUp/Down, 숫자 입력, ±버튼)용
   * — 드래그 중 onAngleChange 와 동등하게 값만 갱신하고 절대 자동 시작하지
   * 않는다. 화살표를 한 번 눌렀다고 타이머가 바로 도는 것은 "미세 조정"의
   * 의미와 맞지 않는다 — 시작은 별도로(Space/Enter, 시작 버튼, 또는 프리셋).
   */
  _previewMinutes(minutes) {
    const state = this._machine.state;
    if (state !== 'idle' && state !== 'setting') return;
    if (state === 'idle') this._machine.send('dialdown');
    this._selectedMinutes = snapMinutes(minutes, 1);
    this._dispatch('ft:set', { minutes: this._selectedMinutes });
    this._render();
  }

  _adjustMinutes(delta) {
    if (this._machine.state === 'running') {
      // §2.3: 실행 중 ±1분 미세 조정 — 남은 시간을 직접 늘리거나 줄인다.
      this.extend(delta * 60000);
      return;
    }
    const next = Math.max(1, Math.min(this._cfg.maxMinutes, this._selectedMinutes + delta));
    this._previewMinutes(next);
  }

  // ---- 런타임 배선 (라이프사이클/리더/타이틀) --------------------------------------
  _wireRuntime() {
    this._lifecycleOff = attachLifecycle(window, document, {
      clock: this._clock,
      onHide: () => {
        this._clock.markGap();
        this._maybeSave(true);
      },
      onShow: () => this._reconcile(),
      onRestore: () => this._reconcile(),
      onResume: () => this._reconcile(),
    });

    this._leader = createLeaderElection(navigator.locks, `${this._cfg.storageKey}:leader-ch`, {
      storage: window.localStorage,
      clock: {
        wall: this._port.wall,
        setTimeout: this._port.setTimeout,
        clearTimeout: this._port.clearTimeout,
      },
      instanceId: this._instanceId,
      lockName: `${this._cfg.storageKey}:leader`,
      storageKey: `${this._cfg.storageKey}:leader-hb`,
    });
    this._leaderOff = this._leader.onLeaderChange(() => {
      this._render();
      this._broadcastSync(); // 새로 리더가 된 탭이 즉시 현재 상태를 알린다
    });
    // 팔로워는 리더의 상태를 그대로 미러링한다 (spec §11 기준 21: 모든 탭이
    // 같은 잔여 시간을 보인다). 알람·알림·저장은 여전히 리더만 한다 — 아래
    // _applyRemoteSync 가 부르는 경로들은 전부 isLeader 로 게이팅되어 있다.
    this._leaderMsgOff = this._leader.onMessage((data) => {
      if (data && data.type === 'sync' && !this.isLeader) this._applyRemoteSync(data);
    });
  }

  /** 리더일 때만 현재 상태를 다른 탭에 브로드캐스트한다. */
  _broadcastSync() {
    if (!this._leader || !this.isLeader) return;
    this._leader.post({
      type: 'sync',
      state: this._machine.state,
      remainingMs: this.remainingMs,
      totalMs: this._totalMs,
    });
  }

  /**
   * 팔로워 전용: 리더가 브로드캐스트한 상태를 로컬 머신/스케줄에 그대로
   * 반영한다. 여기서 호출하는 start/pause/resume/expire 경로는 전부
   * isLeader 게이트가 걸려 있어(오디오/알림/저장/title) 팔로워에서 실행해도
   * 부작용이 없다 — 화면 표시만 리더와 같아진다.
   * @param {{state:string, remainingMs:number, totalMs:number}} data
   */
  _applyRemoteSync(data) {
    if (this.isLeader || this._destroyed || !this._machine) return;
    const target = data.state;
    const cur = this._machine.state;

    if (target === cur) {
      if (target === 'running') this._clock.setRemaining(data.remainingMs);
      this._totalMs = data.totalMs;
      this._render();
      return;
    }

    if (cur !== 'idle') {
      this._schedule.reset();
      this._machine.send('reset');
    }
    if (target === 'idle') {
      this._totalMs = 0;
      this._render();
      return;
    }

    this._totalMs = data.totalMs;
    this._machine.send('start'); // idle -> running (다이얼 조작 없이 직접 전이)
    this._schedule.start(data.totalMs);
    this._clock.setRemaining(data.remainingMs);

    if (target === 'paused') {
      this._schedule.pause();
      this._machine.send('pause');
    } else if (target === 'ringing') {
      this._machine.send('expire'); // running -> ringing
    }
    this._render();
  }

  // ---- 복원 -----------------------------------------------------------------------
  _restoreOrInit() {
    if (!this._storage) return;
    const rec = this._storage.load();
    if (!rec) return;

    const nowWall = this._port.wall();

    if (rec.state === 'paused' && typeof rec.remainingMs === 'number') {
      this._totalMs = rec.totalMs || rec.remainingMs;
      this._schedule.start(rec.remainingMs);
      this._schedule.pause();
      this._machine.send('dialdown');
      this._machine.send('dialup');
      this._machine.send('pause');
      this._render();
      return;
    }

    if (rec.state === 'running' && typeof rec.deadlineWall === 'number') {
      const overdueMs = nowWall - rec.deadlineWall;
      this._totalMs = rec.totalMs || 0;
      if (overdueMs < 0) {
        // 아직 안 끝났다 — 그대로 이어서 돈다.
        this._schedule.start(-overdueMs);
        this._machine.send('dialdown');
        this._machine.send('dialup');
        this._armAlarm(-overdueMs);
        this._syncTitle();
      } else if (overdueMs <= GRACE_MS) {
        // grace 이내 — 알람 재생.
        this._schedule.start(0);
        this._machine.send('dialdown');
        this._machine.send('dialup');
        this._onExpire();
      } else {
        // grace 초과 — 알람 없이 배너만. 자동 진행 없음 (spec §4.4).
        this._showBanner(rec.totalMs, overdueMs);
      }
      this._render();
    }
  }

  _reconcile() {
    if (this._machine.state !== 'running') return;
    const s = this._schedule.settle(this._port.wall());
    if (s.status === 'ringing' && this.isLeader) {
      // settle() 은 순수 함수라 실제 상태 전이는 여기서 한다.
      this._schedule.start(0);
      this._onExpire();
    } else if (s.status === 'completed') {
      this._showBanner(this._totalMs, s.overdueMs);
      this._schedule.reset();
      this._machine.send('reset');
    }
    this._render();
  }

  _showBanner(totalMs, overdueMs) {
    const totalMin = Math.round((totalMs || 0) / 60000);
    const overdueMin = Math.round(overdueMs / 60000);
    this._banner.textContent = `${totalMin}분 타이머가 ${overdueMin}분 전에 끝났습니다.`;
    const restart = el('button', { type: 'button' }, '다시 시작');
    restart.addEventListener('click', () => {
      this._banner.hidden = true;
      this.reset();
    });
    this._banner.append(' ', restart);
    this._banner.hidden = false;
  }

  // ---- 타이머 동작 -----------------------------------------------------------------
  _startTimer(minutes) {
    const totalMs =
      this._cfg.mode === 'pomodoro' && this._pomodoro
        ? this._pomodoro.plannedMs
        : minutes * 60000;
    this._totalMs = totalMs;
    if (this._cfg.mode === 'pomodoro' && this._pomodoro) {
      this._pomodoro.start();
    } else {
      this._schedule.start(totalMs);
    }
    this._armAlarm(this._schedule.remainingMs);
    this._syncTitle();
    this._announce(`${Math.round(totalMs / 60000)}분 타이머 시작`);
    this._save();
    this._broadcastSync();
    this._render();
  }

  _armAlarm(remainingMs) {
    if (!this.isLeader) return;
    this._cancelAlarm();
    this._alarmCancel = this._audio.scheduleAlarm(remainingMs, this._cfg.volume, this._cfg.alarmLength);
  }

  _cancelAlarm() {
    if (this._alarmCancel) {
      this._alarmCancel();
      this._alarmCancel = null;
    }
    this._audio.cancelAll();
  }

  _onExpire() {
    if (!this._machine.send('expire')) return;
    this._dispatch('ft:ring', {});
    this._announce(`${Math.round(this._totalMs / 60000)}분 완료`);
    this._syncTitle();
    if (this.isLeader && this._cfg.notify && this._notifier.permission === 'granted') {
      this._notifier.show(`${Math.round(this._totalMs / 60000)}분 완료`, {
        body: '탭으로 돌아와 확인해주세요.',
        windowRef: window,
      });
    }
    this._save();
    this._broadcastSync();
    this._render();
  }

  // ---- 공개 API (spec §10) ---------------------------------------------------------
  setMinutes(n) {
    // spec §10 은 setMinutes() 와 start() 를 별개 메서드로 나눈다 — 값만 정하고
    // 시작은 별도로 호출하는 것이 API 계약과 맞다. 자동시작이 필요하면
    // `ft.setMinutes(n); ft.start();` 처럼 명시적으로 잇는다.
    this._previewMinutes(n);
  }

  start() {
    const state = this._machine.state;
    if (state === 'idle') {
      if (this._machine.send('start')) this._startTimer(this._selectedMinutes);
    } else if (state === 'setting') {
      if (this._machine.send('start')) this._startTimer(this._selectedMinutes);
    }
  }

  pause() {
    if (!this._machine.send('pause')) return;
    this._schedule.pause();
    this._cancelAlarm();
    this._save();
    this._broadcastSync();
    this._render();
  }

  resume() {
    if (!this._machine.send('resume')) return;
    this._schedule.resume();
    this._armAlarm(this._schedule.remainingMs);
    this._save();
    this._broadcastSync();
    this._render();
  }

  toggle() {
    const state = this._machine.state;
    if (state === 'idle' || state === 'setting') this.start();
    else if (state === 'running') this.pause();
    else if (state === 'paused') this.resume();
    else if (state === 'ringing') this.acknowledge();
  }

  reset() {
    this._cancelAlarm();
    this._schedule.reset();
    this._machine.send('reset');
    this._selectedMinutes = this._cfg.defaultMinutes;
    this._totalMs = 0;
    if (this._cfg.titleSync) releaseTitle(this._instanceId, document);
    this._save(true);
    this._broadcastSync();
    this._render();
  }

  extend(ms) {
    if (this._machine.state !== 'running') return;
    const newRemaining = Math.max(0, this._schedule.remainingMs + ms);
    this._clock.setRemaining(newRemaining);
    this._totalMs = Math.max(this._totalMs, newRemaining);
    if (newRemaining <= 0) {
      // clock.setRemaining(0) marks the clock expired silently (no 'expire'
      // event) since it isn't a tick — a -1분 button pressed to exactly 0
      // must still ring, so trigger it explicitly here.
      this._onExpire();
      return;
    }
    this._armAlarm(newRemaining);
    this._save();
    this._broadcastSync();
    this._render();
  }

  skip() {
    if (this._cfg.mode !== 'pomodoro' || !this._pomodoro) return;
    this._cancelAlarm();
    const record = this._pomodoro.skip();
    this._afterPomodoroAdvance(record);
  }

  acknowledge() {
    if (!this._machine.send('acknowledge')) return;
    this._cancelAlarm();
    const actualMs = this._totalMs;
    if (this._cfg.mode === 'pomodoro' && this._pomodoro) {
      const record = this._pomodoro.complete({ actualMs });
      this._afterPomodoroAdvance(record);
    } else {
      this._dispatch('ft:complete', {
        plannedMs: this._totalMs,
        actualMs,
        skipped: false,
        overdueMs: 0,
      });
      if (this._cfg.titleSync) releaseTitle(this._instanceId, document);
      this._totalMs = 0;
      this._save(true);
    }
    this._broadcastSync();
    this._announce('완료');
    this._render();
  }

  _afterPomodoroAdvance(record) {
    this._dispatch('ft:complete', record);
    this._selectedMinutes = Math.round(this._pomodoro.plannedMs / 60000);
    if (this._pomodoro.isStarted) {
      this._machine.send('dialdown');
      this._machine.send('dialup');
      this._totalMs = this._pomodoro.plannedMs;
      this._armAlarm(this._schedule.remainingMs);
      this._syncTitle();
    } else {
      this._totalMs = 0;
      if (this._cfg.titleSync) releaseTitle(this._instanceId, document);
    }
    this._save(true);
    this._broadcastSync();
  }

  previewAlarm() {
    this._audio.previewAlarm(this._cfg.volume);
  }

  async requestNotifications() {
    return this._notifier.requestPermission();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._cancelAlarm();
    if (this._schedule) this._schedule.reset();
    if (this._machine) this._machine.send('destroy');
    for (const off of this._unsubs) off();
    this._unsubs = [];
    if (this._lifecycleOff) this._lifecycleOff();
    if (this._leader) this._leader.release();
    if (this._cfg && this._cfg.titleSync) releaseTitle(this._instanceId, document);
    if (this._pointer) this._pointer.detach();
    if (this._keyboard) this._keyboard.detach();
    (this._presetDetach || []).forEach((d) => d());
    (this._deltaDetach || []).forEach((d) => d());
    if (this._numberDetach) this._numberDetach();
    if (this._primaryBtn) this._primaryBtn.removeEventListener('click', this._onPrimary);
    if (this._centerStartBtn) this._centerStartBtn.removeEventListener('click', this._onCenterStart);
    if (this._resetBtn) this._resetBtn.removeEventListener('click', this._onReset);
    if (this._previewBtn) this._previewBtn.removeEventListener('click', this._onPreview);
    (this._themeButtons || []).forEach((b) => b.removeEventListener('click', this._onThemeClick));
    (this._gaugeButtons || []).forEach((b) => b.removeEventListener('click', this._onGaugeClick));
    if (this._finetuneToggle) this._finetuneToggle.removeEventListener('click', this._onFinetuneToggle);
    if (this._settingsToggle) this._settingsToggle.removeEventListener('click', this._onSettingsToggle);
    if (this._clockTimerId != null) this._port.clearTimeout(this._clockTimerId);
    if (this._quoteTimerId != null) this._port.clearTimeout(this._quoteTimerId);
    if (this._goalFab) this._goalFab.removeEventListener('click', this._onGoalFabClick);
    if (this._goalInput) {
      this._goalInput.removeEventListener('keydown', this._onGoalKeydown);
      this._goalInput.removeEventListener('blur', this._onGoalBlur);
    }
    if (this._dialContainer) resetDial(this._dialContainer);
    if (this._readoutContainer) resetReadout(this._readoutContainer);
  }

  static define(tag = 'focus-timer') {
    if (!customElements.get(tag)) customElements.define(tag, FocusTimer);
  }

  // ---- 렌더 --------------------------------------------------------------------------
  _render() {
    if (this._destroyed || !this._dialContainer) return;
    const state = this._machine.state;
    const idleLike = state === 'idle' || state === 'setting';
    const remainingMs = this.remainingMs;

    this._dialEl = renderDial(this._dialContainer, {
      minutes: idleLike ? this._selectedMinutes : Math.round(this._totalMs / 60000) || this._selectedMinutes,
      maxMinutes: this._cfg.maxMinutes,
      progress: idleLike ? 1 : this.progress,
      gauge: this._cfg.gauge,
      disabled: !idleLike,
      unit: '분',
      label: '집중 시간',
      locale: this._cfg.lang,
    });

    // 디자인 개편①: 중앙에 항상 M:SS 로 표시한다(예 "50:00") — 기존 스펙(§0.3)
    // 은 60초 이하일 때만 M:SS 로 전환했지만, 참고 디자인처럼 설정 단계부터
    // 항상 "분:초" 로 보여주기로 변경했다(docs/spec-v4.md 각주 참고).
    // idle/setting 에서는 "지금 설정한 총 시간", 그 이후엔 "남은 시간".
    const displayMs = state === 'ringing' ? 0 : idleLike ? this._selectedMinutes * 60000 : remainingMs;

    renderReadout(this._readoutContainer, {
      minutes: Math.floor(displayMs / 60000),
      seconds: Math.floor((displayMs % 60000) / 1000),
      showSeconds: true,
      unit: state === 'ringing' ? '완료' : '분',
      locale: this._cfg.lang,
    });

    const primaryLabel =
      state === 'running' ? '일시정지' : state === 'paused' ? '재개' : state === 'ringing' ? '확인' : '시작';
    const primaryEmoji =
      state === 'running' ? '⏸️' : state === 'paused' ? '▶️' : state === 'ringing' ? '⏹️' : '▶️';
    this._primaryBtn.textContent = primaryEmoji;
    this._primaryBtn.setAttribute('aria-label', primaryLabel);
    // 예전엔 'setting' 상태면 시작 버튼을 비활성화했다 — 'setting' 이 순간적인
    // 드래그 중 상태일 때만 그랬어도 됐지만, 미세 조정(키보드/±/다이얼 클릭)이
    // 전부 'setting' 에 계속 머무는 지금은 이 조건이 곧 "미세 조정을 한 번이라도
    // 하면 시작 버튼이 영영 눌리지 않는" 버그였다 — 제거한다.
    this._primaryBtn.disabled = false;
    this._centerStartBtn.setAttribute('aria-label', primaryLabel);
    this._numberInput.value = idleLike ? String(this._selectedMinutes) : '';
    this._numberInput.disabled = !idleLike;
    this._presetButtons.forEach((b) => (b.disabled = !idleLike));
    this._deltaButtons.forEach((b) => (b.disabled = false));

    if (state === 'ringing' && this._cfg.flash) {
      this._widget.classList.add('is-ringing');
    } else {
      this._widget.classList.remove('is-ringing');
    }

    if (this._persistenceNoticeShown && !this._persistenceAnnounced) {
      this._persistenceAnnounced = true;
      this._announce('기록이 저장되지 않습니다');
    }

    this._renderOptions();
  }

  /** 프리셋/테마/게이지 세그먼트 버튼 중 현재 선택된 것을 표시한다. */
  _renderOptions() {
    if (!this._themeButtons) return;
    const idleLike = this._machine.state === 'idle' || this._machine.state === 'setting';

    const currentTheme = this.getAttribute('theme') || 'auto';
    this._themeButtons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.theme === currentTheme));
    });

    this._gaugeButtons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.gauge === this._cfg.gauge));
    });

    // 프리셋도 세그먼트 버튼 묶음이 됐으니, 지금 설정과 값이 같은 프리셋을
    // 눌린 상태로 보여준다(idle/setting 에서만 — running 중엔 의미 없음).
    this._presetButtons.forEach((btn) => {
      const matches = idleLike && Number(btn.dataset.minutes) === this._selectedMinutes;
      btn.setAttribute('aria-pressed', String(matches));
    });
  }

  _syncTitle() {
    if (!this._cfg.titleSync || !this.isLeader) return;
    if (!claimTitle(this._instanceId, document)) return;
    const min = Math.max(0, Math.ceil(this._schedule.remainingMs / 60000));
    const label = this._machine.state === 'ringing' ? '완료!' : `${min}분 남음`;
    setTitle(this._instanceId, `(${label}) focus-timer`);
  }

  _announce(text) {
    if (!this._liveRegion) return;
    this._liveRegion.textContent = '';
    // 같은 문구 재통지도 낭독되도록 한 틱 비웠다 채운다.
    window.setTimeout(() => {
      if (this._liveRegion) this._liveRegion.textContent = text;
    }, 30);
  }

  _dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  _maybeSave(force) {
    if (!this._storage || !this.isLeader) return;
    const now = this._port.wall();
    if (!force && this._lastSaveWall && now - this._lastSaveWall < 1000) return;
    this._lastSaveWall = now;
    this._save();
  }

  _save(force) {
    if (!this._storage || !this.isLeader) return;
    const state = this._machine.state;
    if (state === 'idle') {
      this._storage.clear();
      return;
    }
    const record = {
      state: state === 'setting' ? 'idle' : state === 'ringing' ? 'running' : state,
      mode: this._cfg.mode,
      phase: this._pomodoro ? this._pomodoro.phase : 'focus',
      totalMs: this._totalMs,
      deadlineWall: this._schedule.status === 'running' ? this._schedule.deadlineWall : null,
      remainingMs: this._schedule.status === 'paused' ? this._schedule.remainingMs : null,
      cycleIndex: this._pomodoro ? this._pomodoro.cycleIndex : 0,
      completedToday: this._completedToday || 0,
    };
    this._storage.save(record);
    if (force) this._lastSaveWall = this._port.wall();
  }
}

FocusTimer.define();

window.FocusTimer = FocusTimer;

export { FocusTimer };
