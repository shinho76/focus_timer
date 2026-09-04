/**
 * Spy AudioContext-like fake for ports/audio.js tests.
 * Records scheduled/cancelled calls instead of producing real sound.
 */
export function createSpyAudioContext({ startTime = 0 } = {}) {
  let currentTime = startTime;
  const oscillators = [];

  class FakeGain {
    constructor() {
      this.gain = {
        value: 0,
        events: [],
        setValueAtTime: (v, t) => this.gain.events.push({ type: 'set', v, t }),
        linearRampToValueAtTime: (v, t) => this.gain.events.push({ type: 'linear', v, t }),
        exponentialRampToValueAtTime: (v, t) => this.gain.events.push({ type: 'exp', v, t }),
      };
    }
    connect(dest) {
      return dest;
    }
  }

  class FakeOscillator {
    constructor() {
      this.frequency = { value: 0 };
      this.started = null;
      this.stopped = null;
      this.stoppedEarly = false;
      oscillators.push(this);
    }
    connect(dest) {
      return dest;
    }
    start(t) {
      this.started = t;
    }
    stop(t) {
      if (this.stopped == null) this.stopped = t;
      else this.stoppedEarly = true;
    }
  }

  return {
    get currentTime() {
      return currentTime;
    },
    advanceTime(sec) {
      currentTime += sec;
    },
    destination: {},
    createOscillator: () => new FakeOscillator(),
    createGain: () => new FakeGain(),
    resume: async () => {
      /* records unlock call */
      return Promise.resolve();
    },
    state: 'running',
    _oscillators: oscillators,
  };
}
