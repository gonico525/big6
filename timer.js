/**
 * timer.js … テンポカウント・休憩タイマー・音生成
 *
 * タイマーは「経過秒を返す共通タイマー」を 1 つだけ実装し、
 * 表示形式と通知条件のみを呼び出し側で切り替える（仕様書 5.5(f)）。
 * 経過時間は常に実時刻から再計算するため、タブ休止で遅れても復帰時に補正される。
 */

// ────────────────────────────────────────────────────────────
// 共通タイマー
// ────────────────────────────────────────────────────────────

export function createTimer({ onTick, onSecond } = {}) {
  let startedAt = null;
  let rafId = null;
  let lastSecond = -1;
  let running = false;

  function frame() {
    if (!running) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    const sec = Math.floor(elapsed);
    if (sec !== lastSecond) {
      lastSecond = sec;
      onSecond?.(sec, elapsed);
    }
    onTick?.(elapsed);
    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      startedAt = performance.now();
      lastSecond = -1;
      running = true;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      rafId = null;
    },
    get running() {
      return running;
    },
    elapsed() {
      return startedAt === null || !running ? 0 : (performance.now() - startedAt) / 1000;
    },
  };
}

/** 秒 → 'MM:SS' */
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

// ────────────────────────────────────────────────────────────
// 音（Web Audio API で生成。音声ファイルを持たない）
// ────────────────────────────────────────────────────────────

export const audio = {
  ctx: null,
  settings: { enabled: true, volume: 0.7 },

  configure(sound) {
    this.settings = { ...this.settings, ...(sound ?? {}) };
  },

  /** iOS は初回の音出しにユーザー操作を要するため、スタートボタンから呼ぶ */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  beep({ freq = 880, duration = 0.05, gain = 1 } = {}) {
    if (!this.settings.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    const vol = Math.max(0, Math.min(1, this.settings.volume)) * gain;
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  },

  /** 毎秒の刻み（同一音） */
  tick() {
    this.beep({ freq: 880, duration: 0.05 });
  },

  /** レップの先頭のみ別の音（低め・長め） */
  repStart() {
    this.beep({ freq: 440, duration: 0.16 });
  },

  /** 休憩中のビープ */
  rest() {
    this.beep({ freq: 660, duration: 0.08 });
  },

  /** 目標に達した合図（高め・長めを 2 連。刻みやレップの先頭と区別する） */
  goal() {
    this.beep({ freq: 1320, duration: 0.18 });
    setTimeout(() => this.beep({ freq: 1320, duration: 0.18 }), 230);
  },
};

// ────────────────────────────────────────────────────────────
// Wake Lock（実行中・休憩中は画面を維持する）
// ────────────────────────────────────────────────────────────

export const wakeLock = {
  sentinel: null,

  async acquire() {
    try {
      if (!('wakeLock' in navigator) || this.sentinel) return;
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
    } catch {
      /* 対応していない環境では黙って諦める */
    }
  },

  async release() {
    try {
      await this.sentinel?.release();
    } catch {
      /* noop */
    }
    this.sentinel = null;
  },

  /** バックグラウンドから復帰したときに取り直す */
  bindVisibility(isActive) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isActive()) this.acquire();
    });
  },
};

// ────────────────────────────────────────────────────────────
// 開始前のカウントダウン
// ────────────────────────────────────────────────────────────

/**
 * テンポカウントを始める前の秒読み。
 * - 残り秒（seconds - 経過秒）を毎フレーム onTick に渡す
 * - 毎秒ビープ、0 になったら自身を止めて onDone を呼ぶ（そこでレップの先頭の音）
 * - 画面はそのままカウントへ移るため、終了時に Wake Lock は手放さない
 */
export function createCountdown({ seconds, onTick, onDone }) {
  let done = false;

  const timer = createTimer({
    onTick(elapsed) {
      if (done) return;
      onTick?.(Math.max(0, seconds - Math.floor(elapsed)), elapsed);
      if (elapsed >= seconds) {
        done = true;
        timer.stop();
        audio.repStart();
        onDone?.();
      }
    },
    onSecond(sec) {
      if (sec < seconds) audio.tick();
    },
  });

  return {
    start() {
      audio.unlock();
      done = false;
      timer.start();
      wakeLock.acquire();
    },
    stop() {
      // 途中でやめたときは onDone を呼ばない
      done = true;
      timer.stop();
      wakeLock.release();
    },
    get running() {
      return timer.running;
    },
  };
}

// ────────────────────────────────────────────────────────────
// テンポカウント
// ────────────────────────────────────────────────────────────

/**
 * テンポカウントを回す。
 * - 毎秒ビープ、レップの先頭のみ別の音
 * - カウントはレップの最終フェーズを完了した時点で +1（進行中は数えない）
 * - targetReps に達したら自動で停止し、onReach を 1 度だけ呼ぶ
 */
export function createRepCounter({ phases, targetReps = 0, onUpdate, onReach }) {
  const cycle = phases.reduce((a, p) => a + p.sec, 0);
  let timer = null;
  let reached = false; // 到達の通知は 1 度だけ（onTick は毎フレーム走るため）

  function phaseAt(elapsed) {
    let t = cycle > 0 ? elapsed % cycle : 0;
    for (const p of phases) {
      if (t < p.sec) return p;
      t -= p.sec;
    }
    return phases[phases.length - 1];
  }

  /** 目標に達する瞬間（= 次のレップの先頭）以降は刻まない */
  const overTarget = (sec) => targetReps > 0 && cycle > 0 && sec >= cycle * targetReps;

  function stop() {
    timer.stop();
    wakeLock.release();
  }

  timer = createTimer({
    onTick(elapsed) {
      const reps = cycle > 0 ? Math.floor(elapsed / cycle) : 0;
      const progress = cycle > 0 ? (elapsed % cycle) / cycle : 0;
      onUpdate({ reps, progress, phase: phaseAt(elapsed), elapsed });
      if (!reached && targetReps > 0 && reps >= targetReps) {
        reached = true;
        stop();
        audio.goal();
        onReach?.(targetReps);
      }
    },
    onSecond(sec) {
      if (overTarget(sec)) return;
      if (sec === 0) {
        audio.repStart();
        return;
      }
      if (cycle > 0 && sec % cycle === 0) audio.repStart();
      else audio.tick();
    },
  });

  return {
    cycle,
    start() {
      audio.unlock();
      timer.start();
      wakeLock.acquire();
    },
    stop,
    get running() {
      return timer.running;
    },
    reps() {
      return cycle > 0 ? Math.floor(timer.elapsed() / cycle) : 0;
    },
  };
}

/**
 * 保持のカウント（mode: hold）。
 * リングは目標秒数で一周し、targetSec に達したら自動で停止して onReach を 1 度だけ呼ぶ。
 * targetSec が 0（目標なし）のときは一周も自動停止もしない。
 */
export function createHoldCounter({ targetSec, onUpdate, onReach }) {
  let reached = false; // 到達の通知は 1 度だけ

  function stop() {
    timer.stop();
    wakeLock.release();
  }

  const timer = createTimer({
    onTick(elapsed) {
      const progress = targetSec > 0 ? Math.min(1, elapsed / targetSec) : 0;
      onUpdate({ elapsed, progress });
      if (!reached && targetSec > 0 && elapsed >= targetSec) {
        reached = true;
        stop();
        audio.goal();
        onReach?.(targetSec);
      }
    },
    onSecond(sec) {
      if (targetSec > 0 && sec >= targetSec) return; // 到達音に譲る
      if (sec === 0) audio.repStart();
      else audio.tick();
    },
  });
  return {
    start() {
      audio.unlock();
      timer.start();
      wakeLock.acquire();
    },
    stop,
    get running() {
      return timer.running;
    },
    seconds() {
      return Math.round(timer.elapsed());
    },
  };
}

/** 休憩タイマー（カウントアップ）。interval 秒ごとにビープ */
export function createRestTimer({ interval, onUpdate }) {
  const timer = createTimer({
    onTick(elapsed) {
      onUpdate(elapsed);
    },
    onSecond(sec) {
      if (sec > 0 && interval > 0 && sec % interval === 0) audio.rest();
    },
  });
  return {
    start() {
      audio.unlock();
      timer.start();
      wakeLock.acquire();
    },
    stop() {
      timer.stop();
      wakeLock.release();
    },
    get running() {
      return timer.running;
    },
    seconds() {
      return Math.round(timer.elapsed());
    },
  };
}
