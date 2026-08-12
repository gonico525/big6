/**
 * sw.js … Service Worker（オフライン動作／仕様書 8. ロードマップ 2）
 *
 * ビルド工程がないためファイル名にハッシュが付かない。そこで
 * stale-while-revalidate（キャッシュを即座に返し、裏で取り直して差し替える）を採る。
 *
 *   - 起動は必ずキャッシュから返るので、圏外・機内モードでも即座に開く
 *   - 更新は次回起動時に反映される（デプロイのたびに CACHE_VERSION を上げなくてよい）
 *   - CACHE_VERSION はキャッシュを丸ごと捨てたいときだけ上げる
 *
 * ただし、呼び出し側が `cache: 'no-cache'` / `'reload'` を指定した要求だけは
 * ネットワークを先に見る。「今この場で最新が欲しい」という明示の意思表示であり、
 * 次回起動まで待つ動作では要求を満たせないため（「テンプレートから読み込む」等）。
 *
 * このファイルはモジュールではない（`type: 'classic'` で登録する）。
 */

const CACHE_VERSION = 'v1';
const CACHE = `prisoner-training-${CACHE_VERSION}`;

/** 事前に取り込むアプリシェル。初回訪問の直後から圏外で動くようにする。 */
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './logic.js',
  './timer.js',
  './store.js',
  './pwa.js',
  './standards.json',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 個別に取る。1 つ失敗しても他を諦めない（addAll は全体が失敗する）
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((e) => {
            console.warn('sw: precache failed', url, e);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/** 保存してよい応答か（エラー応答や他オリジンの opaque を残さない） */
function cacheable(res) {
  return res && res.ok && res.type === 'basic';
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });

      // 裏で取り直してキャッシュを更新する（結果は次回の起動で使われる）
      const fresh = fetch(req)
        .then((res) => {
          if (cacheable(res)) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      // 最新を明示的に求められた場合はネットワーク優先。取れなければキャッシュに戻る
      if (req.cache === 'no-cache' || req.cache === 'reload') {
        const res = await fresh;
        if (res) return res;
        if (cached) return cached;
      }

      if (cached) return cached;

      const res = await fresh;
      if (res) return res;

      // 圏外で未キャッシュのページを開いた場合はアプリシェルを返す
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('オフラインです', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })()
  );
});

self.addEventListener('message', (ev) => {
  // 「更新する」を押したとき、待機中の新しい Service Worker を即座に有効にする
  if (ev.data?.type === 'skip-waiting') self.skipWaiting();
});
