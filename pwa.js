/**
 * pwa.js … Service Worker の登録とホーム画面追加の導線
 *
 * ブラウザ API（navigator / window）だけを扱い、DOM には触れない。
 * 状態が変わったら onChange を呼び、表示は app.js に任せる（timer.js と同じ立ち位置）。
 */

/** 更新確認の最短間隔（ミリ秒）。復帰のたびに取りに行かないための足切り */
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

const state = {
  /** Service Worker が使えるか（HTTPS または localhost のときだけ true） */
  supported: 'serviceWorker' in navigator,
  /** 新しい版が待機中で、再読み込みすれば切り替わる */
  updateReady: false,
  /** ホーム画面に追加済み（standalone で起動している） */
  standalone: false,
};

/** @type {ServiceWorkerRegistration|null} */
let registration = null;
/** @type {ServiceWorker|null} 待機中の新しい Worker */
let waiting = null;
/** @type {any} beforeinstallprompt のイベント（Chromium 系のみ） */
let installEvent = null;
/** 「更新する」を押したかどうか。初回登録時の controllerchange で再読み込みしないための印 */
let updating = false;
let lastCheck = 0;
let onChange = () => {};

function notify() {
  onChange(pwa.state);
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true
  );
}

function watchWaiting(reg) {
  if (reg.waiting && navigator.serviceWorker.controller) {
    waiting = reg.waiting;
    state.updateReady = true;
    notify();
  }
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      // controller がいない＝初回インストール。このときは更新通知を出さない
      if (sw.state === 'installed' && navigator.serviceWorker.controller) {
        waiting = reg.waiting ?? sw;
        state.updateReady = true;
        notify();
      }
    });
  });
}

// beforeinstallprompt は起動直後に飛んでくることがある。init を待たず、
// モジュールの読み込み時点で受け取っておく（取り逃すと追加ボタンを出せない）。
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installEvent = ev;
  notify();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  state.standalone = true;
  notify();
});

export const pwa = {
  get state() {
    return { ...state, canInstall: !!installEvent };
  },

  /**
   * Service Worker の登録と状態変化の購読。onChange は状態が変わるたびに呼ばれる。
   * 起動を遅らせないよう、登録は load 後に行う。
   */
  init(handler = () => {}) {
    onChange = handler;
    state.standalone = isStandalone();

    if (!state.supported) return;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updating) return;
      updating = false;
      window.location.reload();
    });

    const register = () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => {
          registration = reg;
          watchWaiting(reg);
        })
        .catch((e) => console.warn('sw: register failed', e));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.checkForUpdate();
    });
  },

  /** 新しい版が出ていないか確認する（間隔を空けて呼ぶ） */
  checkForUpdate() {
    if (!registration) return;
    const now = Date.now();
    if (now - lastCheck < UPDATE_CHECK_INTERVAL) return;
    lastCheck = now;
    registration.update().catch(() => {});
  },

  /** 待機中の新しい版に切り替える。切り替わると controllerchange で再読み込みされる */
  applyUpdate() {
    if (!state.updateReady) return;
    updating = true;
    state.updateReady = false;
    notify();
    if (waiting) waiting.postMessage({ type: 'skip-waiting' });
    else window.location.reload();
  },

  /**
   * ホーム画面への追加を促す。Chromium 系でのみ動く。
   * @returns {Promise<boolean>} 追加されたら true
   */
  async promptInstall() {
    if (!installEvent) return false;
    const ev = installEvent;
    installEvent = null;
    notify();
    ev.prompt();
    const { outcome } = await ev.userChoice;
    return outcome === 'accepted';
  },
};
