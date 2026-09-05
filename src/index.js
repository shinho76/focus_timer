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
    this._restoreOrInit();
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
  _buildShadow() {
    applyStyles(this.shadowRoot, CSS_TEXT);

    const widget = el('div', { class: 'ft-widget', part: 'controls' });

    // 다이얼과 리드아웃을 별도의 위치기준 상자(.ft-stage)로 묶는다 — 리드아웃의
    // `position:absolute; inset:0` 은 이 상자를 기준으로 삼아야 다이얼 위에
    // 정확히 겹친다. 위젯(.ft-widget) 자체를 기준으로 삼으면 그 아래 컨트롤/
    // 옵션 영역까지 포함한 전체 높이의 중앙에 텍스트가 떠서, 컨트롤이 늘어날
    // 때마다(이번 옵션 버튼 추가처럼) 다이얼과 어긋난다.
    const stage = el('div', { class: 'ft-stage' });
    this._dialContainer = el('div');
    stage.append(this._dialContainer);

    this._readoutContainer = el('div');
    stage.append(this._readoutContainer);
    widget.append(stage);

    this._liveRegion = el('div', {
      'aria-live': 'polite',
      class: 'ft-sr-only',
    });
    widget.append(this._liveRegion);

    this._banner = el('div', { class: 'ft-banner', hidden: '' });
    widget.append(this._banner);

    const controls = el('div', { class: 'ft-controls', part: 'controls' });

    // 프리셋은 5~60분 9종을 세그먼트 버튼(한 줄로 이어붙인 버튼 묶음)으로 —
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

    this._deltaButtons = DELTA_STEPS.map((d) =>
      el('button', { type: 'button', 'data-delta': String(d) }, d > 0 ? `+${d}` : String(d)),
    );
    this._deltaButtons.forEach((b) => controls.append(b));

    this._numberInput = el('input', {
      type: 'number',
      min: '1',
      max: String(this._cfg.maxMinutes),
      'aria-label': '분 직접 입력',
    });
    controls.append(this._numberInput);

    this._primaryBtn = el('button', { type: 'button', part: 'pause-button' }, '시작');
    controls.append(this._primaryBtn);

    this._resetBtn = el('button', { type: 'button' }, '리셋');
    controls.append(this._resetBtn);

    this._previewBtn = el('button', { type: 'button' }, '알람 미리 듣기');
    controls.append(this._previewBtn);

    widget.append(controls);
    widget.append(this._buildOptions());
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
        this._selectedMinutes = minutes;
        if (this._cfg.autostartOnRelease) {
          if (this._machine.send('dialup')) this._startTimer(minutes);
        } else {
          this._render();
        }
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
    this._onReset = () => this.reset();
    this._resetBtn.addEventListener('click', this._onReset);
    this._onPreview = () => this._audio.previewAlarm(this._cfg.volume);
    this._previewBtn.addEventListener('click', this._onPreview);

    this._wireOptions();
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
    if (this._resetBtn) this._resetBtn.removeEventListener('click', this._onReset);
    if (this._previewBtn) this._previewBtn.removeEventListener('click', this._onPreview);
    (this._themeButtons || []).forEach((b) => b.removeEventListener('click', this._onThemeClick));
    (this._gaugeButtons || []).forEach((b) => b.removeEventListener('click', this._onGaugeClick));
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

    this._primaryBtn.textContent =
      state === 'running' ? '일시정지' : state === 'paused' ? '재개' : state === 'ringing' ? '확인' : '시작';
    this._primaryBtn.disabled = state === 'setting';
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
