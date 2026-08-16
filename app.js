/**
 * app.js … 画面と状態管理
 */

import { store, createInitialData, defaultSettings, defaultInitialState } from './store.js';
import * as L from './logic.js';
import { pwa } from './pwa.js';
import {
  audio,
  wakeLock,
  createCountdown,
  createRepCounter,
  createHoldCounter,
  createRestTimer,
  formatClock,
} from './timer.js';

// ────────────────────────────────────────────────────────────
// 定数
// ────────────────────────────────────────────────────────────

/** 「スタート」を押してからカウントが始まるまでの秒数（構える時間） */
const COUNTDOWN_SEC = 6;

// ────────────────────────────────────────────────────────────
// 状態
// ────────────────────────────────────────────────────────────

/** @type {any} 保存データ（store が正） */
let data = null;
/** @type {{name:string, [k:string]:any}} 現在の画面 */
let view = { name: 'home' };
/** @type {any} 実行中の状態（画面を離れると破棄） */
let run = null;
/** @type {any} モーダル */
let modal = null;
/** @type {any} PWA の状態（更新の待機・ホーム画面追加の可否） */
let pwaState = pwa.state;

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');

// ────────────────────────────────────────────────────────────
// 小道具
// ────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const num = (v, fallback = 0) => {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
};

function save() {
  store.save(data);
}

/** テーマ設定を <html data-theme> に反映する（実際の配色切り替えは style.css 側） */
function applyTheme() {
  document.documentElement.dataset.theme = data.settings.theme ?? 'system';
}

function go(name, params = {}) {
  if (run && name !== 'run') stopRun();
  view = { name, ...params };
  modal = null;
  render();
  window.scrollTo(0, 0);
}

function openModal(m) {
  modal = m;
  renderModal();
}

function closeModal() {
  modal = null;
  renderModal();
}

// ────────────────────────────────────────────────────────────
// 起動
// ────────────────────────────────────────────────────────────

async function boot() {
  data = store.load();
  if (!data) {
    const template = await fetch('./standards.json', { cache: 'no-cache' }).then((r) => r.json());
    data = createInitialData(template);
    save();
  }
  applyTheme();
  audio.configure(data.settings.sound);
  wakeLock.bindVisibility(() => !!run && (run.countdown?.running || run.counter?.running || run.rest?.running));
  pwa.init((s) => {
    pwaState = s;
    // 実行中の再描画はカウント表示の書き換え先を失わせるので避ける（次の描画で反映される）
    if (view.name !== 'run') render();
  });
  render();
}

boot().catch((e) => {
  app.innerHTML = `<div class="card"><h2>起動に失敗しました</h2><p class="small muted">${esc(e.message)}</p></div>`;
});

// ────────────────────────────────────────────────────────────
// 描画
// ────────────────────────────────────────────────────────────

function render() {
  const views = {
    home: renderHome,
    run: renderRun,
    progress: renderProgress,
    settings: renderSettings,
    standards: renderStandardsEditor,
  };
  app.innerHTML = (views[view.name] ?? renderHome)();
  renderModal();
  if (view.name === 'run') afterRunRender();
}

function renderModal() {
  modalRoot.innerHTML = modal ? `<div class="modal-back" data-act="modal-back"><div class="modal">${modal()}</div></div>` : '';
}

function topbar(title, right = '') {
  return `<div class="topbar">
    <button class="btn ghost small" data-act="home">‹ ホーム</button>
    <h1>${esc(title)}</h1>${right}
  </div>`;
}

// ────────────────────────────────────────────────────────────
// ホーム
// ────────────────────────────────────────────────────────────

function renderHome() {
  const today = L.toDateStr();
  const states = data.exercises.map((e) => L.exerciseState(data, e.id, today));
  const visible = L.homeOrder(states.filter((s) => s.unlocked));
  const hidden = states.filter((s) => !s.unlocked);
  const unfilled = states.filter((s) => !s.ready);

  return `
  <div class="topbar">
    <div class="week">今週<b>${L.weekTotal(data, today)}</b>回</div>
    <div class="spacer"></div>
    <button class="btn ghost small" data-act="progress">進捗</button>
    <button class="btn ghost small" data-act="settings">設定</button>
  </div>
  ${pwaState.updateReady ? updateBanner() : ''}
  ${data.pending ? pendingBanner() : ''}
  ${
    unfilled.length
      ? `<div class="banner">
          <div><b>ステップマスタが未入力です</b></div>
          <div class="small muted" style="margin:4px 0 10px">
            書籍を参照して、${esc(unfilled.map((s) => s.name).join('・'))} の基準値を入力してください。
          </div>
          <button class="btn small" data-act="standards">まとめて入力する</button>
        </div>`
      : ''
  }
  ${visible.map(exCard).join('')}
  ${hidden.length ? `<div class="section-title">まだ推奨されていない種目</div>${hidden.map(lockedCard).join('')}` : ''}
  `;
}

function exCard(s) {
  const target = s.ready
    ? `<div class="target">${esc(L.targetText(s.target, s.unit, s.perSide))}</div>`
    : `<div class="target unset">基準値が未入力です</div>`;
  const badges = [];
  if (s.promotion.ok) badges.push(`<button class="btn accent small" data-act="promote" data-ex="${s.id}">Step${s.step + 1} に昇格する</button>`);
  if (s.demotion.ok) badges.push(`<button class="btn small" data-act="demote" data-ex="${s.id}">Step${s.step - 1} に下げる</button>`);

  return `<div class="card">
    <button class="ex-card" data-act="open" data-ex="${s.id}">
      <div class="name">${esc(s.name)}</div>
      <div class="step">Step${s.step}　${esc(s.stepName)}　<span class="muted">${L.LEVEL_NAMES[s.level]}</span></div>
      ${target}
      <div class="meta">
        <span>今週 ${s.weekCount}回</span>
        <span>${s.lastDate ? `前回 ${esc(L.relativeDay(s.lastDate))}` : '記録なし'}</span>
      </div>
    </button>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    ${s.ready ? '' : quickStandardForm(s)}
  </div>`;
}

/** カード上の基準値入力欄（仕様書 5.2） */
function quickStandardForm(s) {
  const std = s.std ?? { levels: { 1: {}, 2: {}, 3: {} } };
  const cell = (lv) => `
    <div class="lv-row">
      <span class="lv-name">${L.LEVEL_NAMES[lv]}</span>
      <input type="number" inputmode="numeric" placeholder="セット" data-quick="${s.id}:${s.step}:${lv}:sets" value="${std.levels?.[lv]?.sets ?? ''}">
      <span class="times">×</span>
      <input type="number" inputmode="numeric" placeholder="${s.unit === 'sec' ? '秒' : '回'}" data-quick="${s.id}:${s.step}:${lv}:value" value="${std.levels?.[lv]?.value ?? ''}">
    </div>`;
  return `<div style="margin-top:12px">
    <div class="small muted" style="margin-bottom:6px">Step${s.step} ${esc(s.stepName)} の基準値</div>
    ${[1, 2, 3].map(cell).join('')}
    <div class="row" style="margin-top:10px">
      <button class="btn small primary" data-act="save-quick" data-ex="${s.id}" data-step="${s.step}">保存</button>
      <button class="btn small ghost" data-act="standards">詳細を編集</button>
    </div>
  </div>`;
}

function lockedCard(s) {
  return `<button class="locked" data-act="locked" data-ex="${s.id}">
    <span class="name">${esc(s.name)}</span>
    <span class="small">まだ推奨されません</span>
    <span>›</span>
  </button>`;
}

/** 新しい版の Service Worker が待機しているときの案内 */
function updateBanner() {
  return `<div class="banner">
    <div><b>新しい版があります</b></div>
    <div class="small muted" style="margin:4px 0 10px">
      更新すると再読み込みされます。記録はこの端末に残ります。
    </div>
    <button class="btn small primary" data-act="apply-update">更新する</button>
  </div>`;
}

function pendingBanner() {
  const p = data.pending;
  const meta = L.getExercise(data, p.exercise);
  const done = p.sets.length;
  return `<div class="banner">
    <div><b>${esc(p.date)} ${esc(meta?.name ?? p.exercise)} の記録が途中です</b></div>
    <div class="small muted" style="margin:4px 0 10px">
      ${done ? `${done}セット目 ${esc(L.setsText([p.sets[done - 1]], p.perSide))} まで完了` : 'まだセットの記録はありません'}
    </div>
    <div class="row wrap">
      <button class="btn small primary" data-act="pending-resume">続きから</button>
      <button class="btn small" data-act="pending-keep" ${done ? '' : 'disabled'}>ここまでを記録</button>
      <button class="btn small danger" data-act="pending-discard">破棄</button>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────
// 種目実行
// ────────────────────────────────────────────────────────────

function startRun(ex, { fromPending = false } = {}) {
  const s = L.exerciseState(data, ex);
  if (!s.ready) {
    go('standards', { ex });
    return;
  }
  if (fromPending && data.pending && data.pending.exercise === ex) {
    // 中断中にステップが変わっている可能性があるため、記録側のステップを正とする
    const p = data.pending;
    const std = L.getStandard(data, ex, p.step);
    run = {
      ...baseRun(s),
      id: p.id,
      date: p.date,
      step: p.step,
      stepName: std?.name ?? `Step${p.step}`,
      description: L.stepDescription(data, ex, p.step),
      unit: p.unit ?? std?.unit ?? 'reps',
      mode: std?.mode ?? 'rep',
      perSide: p.perSide ?? std?.perSide ?? false,
      target: p.targetOfDay,
      sets: p.sets ?? [],
      partial: p.partial ?? null,
      side: p.partial != null ? 1 : 0,
    };
  } else {
    run = baseRun(s);
  }
  view = { name: 'run', ex };
  render();
}

function baseRun(s) {
  const date = L.toDateStr();
  return {
    ex: s.id,
    name: s.name,
    step: s.step,
    stepName: s.stepName,
    description: s.description,
    startPhase: s.startPhase,
    unit: s.unit,
    mode: s.mode,
    perSide: s.perSide,
    target: s.target,
    date,
    id: L.nextRecordId(data.records, date, s.id),
    sets: [],
    partial: null,
    side: 0,
    phase: 'idle',
    countdown: null,
    counter: null,
    rest: null,
    confirmValue: 0,
    live: null,
  };
}

function stopRun() {
  run?.countdown?.stop();
  run?.counter?.stop();
  run?.rest?.stop();
  wakeLock.release();
  run = null;
}

/** セットを確定したあと・休憩から戻ったあとに表示する画面 */
function phaseAfterSet(r) {
  // 片側種目で左だけ終えている間は、まだそのセットの途中
  if (r.partial != null) return 'idle';
  return r.sets.length >= (r.target.sets ?? 1) ? 'done' : 'idle';
}

function renderRun() {
  const r = run;
  if (!r) return renderHome();
  const u = L.unitLabel(r.unit);

  const bodies = {
    countdown: () => runCountdown(r),
    counting: () => runCounting(r),
    confirm: () => runConfirm(r, u),
    rest: () => runRest(r),
    done: () => runDone(r, u),
  };
  const body = (bodies[r.phase] ?? (() => runIdle(r, u)))();

  return `
  ${topbar(r.name, `<button class="btn ghost small" data-act="abort">中断</button>`)}
  <div class="run-head">
    <div class="step">
      <span>Step${r.step}　${esc(r.stepName)}</span>${
        r.description
          ? `<button class="tip-btn" data-act="tip" aria-expanded="false" aria-controls="step-tip" aria-label="このステップの説明">ⓘ</button>`
          : ''
      }
    </div>
    ${r.description ? `<div class="tip" id="step-tip" role="tooltip" hidden>${esc(r.description)}</div>` : ''}
  </div>
  <div class="card">
    <div class="run-target">目標　${esc(L.targetText(r.target, r.unit, r.perSide))}</div>
    ${
      r.mode === 'rep'
        ? `<div class="run-tempo">テンポ ${esc(L.tempoText(r.startPhase, data.settings.tempo))}</div>`
        : r.mode === 'hold'
          ? `<div class="run-tempo">保持 ${r.target.value}秒でリングが一周します</div>`
          : `<div class="run-tempo">カウントなし。実施後に実績を入力します</div>`
    }
  </div>
  ${body}
  ${setList(r, u)}
  `;
}

/** 「3セット目（左）」のような、これから行うセットの呼び名 */
function setLabel(r) {
  const sideLabel = r.perSide ? (r.side === 0 ? '左' : '右') : '';
  return `${r.sets.length + 1}セット目${sideLabel ? `（${sideLabel}）` : ''}`;
}

function runIdle(r, u) {
  const doneSets = r.sets.length;
  const enough = doneSets >= (r.target.sets ?? 1);
  const label = r.mode === 'free' ? `${setLabel(r)} を入力` : `${setLabel(r)} スタート`;

  return `
  <div class="stack">
    <button class="btn big block primary" data-act="start">${esc(label)}</button>
    ${doneSets || r.partial != null ? `<button class="btn block" data-act="rest">休憩する</button>` : ''}
    ${doneSets ? `<button class="btn block ${enough ? 'accent' : ''}" data-act="finish">ワークアウトを終了して記録</button>` : ''}
  </div>`;
}

function runCountdown(r) {
  return `
  <div class="card">
    <div class="muted" style="text-align:center">${esc(setLabel(r))}　まもなく開始</div>
    <div class="countdown" id="countdown-value">${COUNTDOWN_SEC}</div>
    <div class="small muted" style="text-align:center">開始の姿勢で構えてください</div>
    <button class="btn big block" data-act="countdown-cancel" style="margin-top:16px">やめる</button>
  </div>`;
}

function runCounting(r) {
  const isHold = r.mode === 'hold';
  return `
  <div class="ring-wrap">
    <div class="ring">
      <svg viewBox="0 0 120 120">
        <circle class="track" cx="60" cy="60" r="52"></circle>
        <circle class="bar" id="ring-bar" cx="60" cy="60" r="52" stroke-dasharray="326.7" stroke-dashoffset="326.7"></circle>
      </svg>
      <div class="inner">
        <div class="count" id="ring-count">${isHold ? 0 : 1}</div>
        <div class="unit">${isHold ? '秒' : '回'}</div>
        <div class="phase" id="ring-phase"></div>
      </div>
    </div>
  </div>
  <button class="btn big block" data-act="stop">${isHold ? '終了して秒数を入力' : '終了'}</button>`;
}

function runConfirm(r, u) {
  return `
  <div class="card">
    <div style="text-align:center" class="muted"><span id="confirm-echo">${esc(r.confirmValue)}</span> ${u}で終了</div>
    <div class="stepper">
      <button class="btn" data-act="dec">−</button>
      <div class="value" id="confirm-value">${esc(r.confirmValue)}</div>
      <button class="btn" data-act="inc">＋</button>
    </div>
    <button class="btn big block primary" data-act="record">記録する</button>
  </div>`;
}

function runRest(r) {
  return `
  <div class="card">
    <div class="muted" style="text-align:center">休憩</div>
    <div class="rest-clock" id="rest-clock">00:00</div>
    <button class="btn big block primary" data-act="rest-end">次のセットへ</button>
  </div>`;
}

function runDone(r, u) {
  return `
  <div class="card">
    <div class="run-target">目標のセット数が終わりました</div>
    <div class="run-tempo">実績　${esc(L.setsText(r.sets, r.perSide))} ${esc(u)}</div>
  </div>
  <div class="stack">
    <button class="btn big block primary" data-act="finish">記録する</button>
    <button class="btn block" data-act="add-set">もう1セット追加</button>
    <button class="btn block" data-act="rest">休憩する</button>
  </div>`;
}

function setList(r, u) {
  // 完了画面では次のセットの行は出さない（もう終わっているため）
  const upto = r.phase === 'done' ? r.sets.length : r.sets.length + 1;
  const total = Math.max(r.target.sets ?? 1, upto);
  const items = [];
  for (let i = 0; i < total; i++) {
    const v = r.sets[i];
    const active = i === r.sets.length;
    let text = '—';
    if (v !== undefined) text = r.perSide ? `左 ${v[0]}${u} / 右 ${v[1]}${u}` : `${v}${u}`;
    else if (active && r.partial != null) text = `左 ${r.partial}${u} / 右 —`;
    items.push(`<div class="item ${active ? 'active' : ''}"><span>${i + 1}セット目</span><span>${esc(text)}</span></div>`);
  }
  return `<div class="card setlist">${items.join('')}</div>`;
}

function afterRunRender() {
  const r = run;
  if (!r) return;
  if (r.phase === 'countdown' && !r.countdown) startCountdown();
  if (r.phase === 'counting' && !r.counter) startCounter();
  if (r.phase === 'rest' && !r.rest) startRest();
}

function startCountdown() {
  const r = run;
  const el = $('#countdown-value');
  r.countdown = createCountdown({
    seconds: COUNTDOWN_SEC,
    onTick: (remain) => {
      if (el) el.textContent = String(remain);
    },
    onDone: () => {
      // 描画のあと afterRunRender からテンポカウントが始まる
      r.countdown = null;
      r.phase = 'counting';
      render();
    },
  });
  r.countdown.start();
}

/** 目標に達したので、カウントを止めて確認画面へ進む（タイマー側で 1 度だけ呼ばれる） */
function goalReached() {
  const r = run;
  if (!r || r.phase !== 'counting') return;
  r.counter = null;
  r.confirmValue = r.target.value ?? 0;
  r.phase = 'confirm';
  render();
}

function startCounter() {
  const r = run;
  const bar = $('#ring-bar');
  const count = $('#ring-count');
  const phaseEl = $('#ring-phase');
  const C = 2 * Math.PI * 52;

  const paint = (progress, value, label) => {
    if (bar) bar.style.strokeDashoffset = String(C * (1 - Math.min(1, progress)));
    if (count) count.textContent = String(value);
    if (phaseEl) phaseEl.textContent = label ?? '';
  };

  if (r.mode === 'hold') {
    r.counter = createHoldCounter({
      targetSec: r.target.value || 0,
      onUpdate: ({ elapsed, progress }) => paint(progress, Math.floor(elapsed), '保持'),
      onReach: goalReached,
    });
  } else {
    const phases = L.phaseSequence(r.startPhase, data.settings.tempo);
    if (!phases.length) {
      // テンポがすべて 0 の場合はカウントできない
      r.phase = 'confirm';
      r.confirmValue = r.target.value ?? 0;
      render();
      return;
    }
    r.counter = createRepCounter({
      phases,
      targetReps: r.target.value || 0,
      onUpdate: ({ rep, progress, phase }) => paint(progress, rep, phase.label),
      onReach: goalReached,
    });
  }
  r.counter.start();
}

function startRest() {
  const r = run;
  const el = $('#rest-clock');
  r.rest = createRestTimer({
    interval: data.settings.restBeepInterval,
    onUpdate: (elapsed) => {
      if (el) el.textContent = formatClock(elapsed);
    },
  });
  r.rest.start();
}

function setConfirmValue(v) {
  run.confirmValue = Math.max(0, v);
  const text = String(run.confirmValue);
  const value = $('#confirm-value');
  const echo = $('#confirm-echo');
  if (value) value.textContent = text;
  if (echo) echo.textContent = text;
}

/** セット（または片側ブロック）の実績を確定する */
function commitValue(value) {
  const r = run;
  if (r.perSide) {
    if (r.side === 0) {
      r.partial = value;
      r.side = 1;
    } else {
      r.sets.push([r.partial ?? 0, value]);
      r.partial = null;
      r.side = 0;
    }
  } else {
    r.sets.push(value);
  }
  savePending();
  r.phase = phaseAfterSet(r);
  render();
}

/** セット完了ごとに未確定レコードを書き込む（仕様書 5.5(g)） */
function savePending() {
  const r = run;
  data.pending = {
    id: r.id,
    date: r.date,
    exercise: r.ex,
    step: r.step,
    unit: r.unit,
    perSide: r.perSide,
    sets: r.sets,
    partial: r.partial,
    targetOfDay: r.target,
  };
  save();
}

/** ワークアウトを確定してレコードにする */
function finishRun(sets = null) {
  const r = run;
  const list = sets ?? r.sets;
  if (list.length) {
    data.records.push({
      id: r.id,
      date: r.date,
      exercise: r.ex,
      step: r.step,
      unit: r.unit,
      perSide: r.perSide,
      sets: list,
      targetOfDay: r.target,
      achieved: L.judgeAchieved(list, r.target),
    });
  }
  data.pending = null;
  save();
  stopRun();
  go('home');
}

// ────────────────────────────────────────────────────────────
// 進捗
// ────────────────────────────────────────────────────────────

function renderProgress() {
  const today = L.toDateStr();
  const month = view.month ?? today.slice(0, 7);
  const head = ['<div></div>', ...Array.from({ length: 10 }, (_, i) => `<div class="head">${i + 1}</div>`)].join('');
  const rows = data.exercises
    .map((e) => {
      const cells = Array.from({ length: 10 }, (_, i) => {
        const c = L.gridCell(data, e.id, i + 1, today);
        return `<button class="cell" data-act="cell" data-ex="${e.id}" data-step="${i + 1}"
          data-state="${c.state}" data-level="${c.level}" data-current="${c.current}"
          title="${esc(e.name)} Step${i + 1}">
          <span class="fill" style="height:${Math.round(c.fill * 100)}%"></span>
        </button>`;
      }).join('');
      return `<div class="rowlabel">${esc(e.name)}</div>${cells}`;
    })
    .join('');

  const sel = view.ex ? historyPanel(view.ex, view.step) : '';

  return `
  ${topbar('進捗')}
  ${renderCalendar(month, today)}
  <div class="card">
    <div class="grid-table">${head}${rows}</div>
    <div class="legend">
      <span><i style="background:var(--lv1)"></i>初級</span>
      <span><i style="background:var(--lv2)"></i>中級</span>
      <span><i style="background:var(--lv3)"></i>上級</span>
      <span><i style="background:var(--accent)"></i>昇格可能</span>
      <span><i style="border-width:2px;border-color:var(--text)"></i>現在のステップ</span>
    </div>
    <div class="grid-hint small muted">マスをタップすると、そのステップの記録が下に出ます</div>
  </div>
  <div class="row" style="margin-bottom:12px">
    <button class="btn small" data-act="add-record">記録を追加</button>
  </div>
  ${sel}`;
}

/** 実施した種目数（0〜6）を色の濃さの段階に割り当てる */
function calLevel(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  return 3;
}

function renderCalendar(month, today) {
  const weekStart = data.settings.weekStart;
  const weeks = L.monthGrid(month, weekStart);
  const from = weeks[0].find(Boolean) ?? `${month}-01`;
  const to = [...weeks[weeks.length - 1]].reverse().find(Boolean) ?? from;
  const counts = L.dailyExerciseCounts(data, from, to);
  const [y, m] = month.split('-').map(Number);
  const order = [...WEEKDAYS.slice(WEEKDAYS.findIndex(([k]) => k === weekStart)), ...WEEKDAYS.slice(0, WEEKDAYS.findIndex(([k]) => k === weekStart))];
  const head = order.map(([, label]) => `<div class="cal-head">${label}</div>`).join('');
  const cells = weeks
    .map((week) =>
      week
        .map((date) => {
          if (!date) return `<div class="cal-cell empty"></div>`;
          const n = counts[date] ?? 0;
          return `<div class="cal-cell${date > today ? ' future' : ''}" data-level="${calLevel(n)}" data-today="${date === today}"
            title="${date}　${n}種目">
            <span class="d">${Number(date.slice(8))}</span>${n ? `<span class="n">${n}</span>` : ''}
          </div>`;
        })
        .join('')
    )
    .join('');

  return `
  <div class="card">
    <div class="row between" style="margin-bottom:8px">
      <button class="btn ghost small" data-act="cal-prev">‹</button>
      <b>${y}年${m}月</b>
      <button class="btn ghost small" data-act="cal-next">›</button>
    </div>
    <div class="cal-table">${head}${cells}</div>
    <div class="legend">
      <span><i style="background:var(--lv0)"></i>0種目</span>
      <span><i style="background:var(--lv1)"></i>1〜2種目</span>
      <span><i style="background:var(--lv2)"></i>3〜4種目</span>
      <span><i style="background:var(--lv3)"></i>5〜6種目</span>
    </div>
    <div class="grid-hint small muted">毎日やる必要はありません。週の中でどれだけ実施できたかの目安です</div>
  </div>`;
}

function historyPanel(ex, step) {
  const meta = L.getExercise(data, ex);
  const std = L.getStandard(data, ex, step);
  const recs = L.recordsFor(data, ex, step);
  const rows = recs.length
    ? recs.map(historyRow).join('')
    : `<div class="empty">このステップの記録はありません</div>`;
  return `<div class="card">
    <div class="row between" style="margin-bottom:8px">
      <b>${esc(meta?.name ?? ex)}　Step${step}</b>
      <span class="small muted">${esc(std?.name ?? '')}</span>
    </div>
    ${rows}
  </div>`;
}

function historyRow(r) {
  const u = L.unitLabel(r.unit);
  const t = r.targetOfDay;
  return `<button class="hist-row" data-act="edit-record" data-id="${esc(r.id)}">
    <div class="line1">
      <span class="date">${esc(r.date.slice(5).replace('-', '/'))}</span>
      <span class="sets">${esc(r.sets.length)}×${esc(L.setsText(r.sets, r.perSide))}</span>
      <span class="judge ${r.achieved ? 'ok' : 'ng'}">${r.achieved ? '達成' : '未達'}</span>
    </div>
    <div class="line2">目標 ${esc(t ? `${t.sets}×${r.perSide ? '左右各' : ''}${t.value}${u}` : '—')}</div>
  </button>`;
}

// ────────────────────────────────────────────────────────────
// 記録の追加・修正・削除
// ────────────────────────────────────────────────────────────

function parseSets(str, perSide) {
  return String(str)
    .split(',')
    .map((s) => s.trim().replace(/[()（）]/g, ''))
    .filter(Boolean)
    .map((tok) => {
      if (perSide) {
        const [a, b] = tok.split(/[/／]/);
        return [Math.max(0, num(a)), Math.max(0, num(b ?? a))];
      }
      return Math.max(0, num(tok));
    });
}

function setsToInput(sets, perSide) {
  if (!sets?.length) return '';
  return sets.map((s) => (perSide || Array.isArray(s) ? `${s[0]}/${s[1]}` : s)).join(', ');
}

function recordForm(rec) {
  const editing = !!rec.id;
  const std = L.getStandard(data, rec.exercise, rec.step);
  const perSide = std?.perSide ?? false;
  const u = L.unitLabel(std?.unit ?? 'reps');
  return () => `
    <h2>${editing ? '記録を修正' : '記録を追加'}</h2>
    <label class="field"><span>日付</span><input type="date" id="f-date" value="${esc(rec.date)}"></label>
    <div class="grid2">
      <label class="field"><span>種目</span>
        <select id="f-ex">${data.exercises.map((e) => `<option value="${e.id}" ${e.id === rec.exercise ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>ステップ</span>
        <select id="f-step">${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${i + 1 === rec.step ? 'selected' : ''}>Step${i + 1}</option>`).join('')}</select>
      </label>
    </div>
    <label class="field">
      <span>セット実績（カンマ区切り${perSide ? '。片側種目は 左/右' : ''}）</span>
      <input type="text" id="f-sets" inputmode="numeric" placeholder="${perSide ? '10/9, 10/8' : '20, 20, 18'}" value="${esc(setsToInput(rec.sets, perSide))}">
    </label>
    <div class="grid2">
      <label class="field"><span>目標セット数</span><input type="number" inputmode="numeric" id="f-tsets" value="${esc(rec.targetOfDay?.sets ?? '')}"></label>
      <label class="field"><span>目標${u}数${perSide ? '（片側）' : ''}</span><input type="number" inputmode="numeric" id="f-tvalue" value="${esc(rec.targetOfDay?.value ?? '')}"></label>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-act="save-record" data-id="${esc(rec.id ?? '')}">保存</button>
      <button class="btn ghost" data-act="close-modal">キャンセル</button>
      <div class="spacer"></div>
      ${editing ? `<button class="btn danger ghost" data-act="delete-record" data-id="${esc(rec.id)}">削除</button>` : ''}
    </div>
    <p class="small muted" style="margin-top:10px">達成の可否は目標と実績から自動で判定します。</p>`;
}

function saveRecordFromForm(id) {
  const date = $('#f-date').value || L.toDateStr();
  const exercise = $('#f-ex').value;
  const step = num($('#f-step').value, 1);
  const std = L.getStandard(data, exercise, step);
  const perSide = std?.perSide ?? false;
  const sets = parseSets($('#f-sets').value, perSide);
  if (!sets.length) {
    alert('セット実績を入力してください');
    return;
  }
  const target = { sets: num($('#f-tsets').value, sets.length), value: num($('#f-tvalue').value, 0) };
  const rec = {
    id: id || L.nextRecordId(data.records, date, exercise),
    date,
    exercise,
    step,
    unit: std?.unit ?? 'reps',
    perSide,
    sets,
    targetOfDay: target,
    achieved: L.judgeAchieved(sets, target),
  };
  const i = data.records.findIndex((r) => r.id === id);
  if (i >= 0) data.records[i] = rec;
  else data.records.push(rec);
  save();
  closeModal();
  render();
}

// ────────────────────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────────────────────

const SETTING_FIELDS = [
  ['unlockStep', '解禁ステップ', 'number', 1, 10],
  ['maxIncrement', '増加量の上限（回数系）', 'number', 1, 50],
  ['secIncrement', '増加量（秒数系）', 'number', 1, 120],
  ['initialRatio', '昇格直後の係数', 'number', 0, 1],
  ['promotionCount', '昇格提案に必要な達成回数', 'number', 1, 50],
  ['minWeeksPerStep', 'ステップ最低継続週数', 'number', 0, 52],
  ['demoteThreshold', '降格提案のしきい値', 'number', 1, 20],
  ['restBeepInterval', '休憩のビープ間隔（秒）', 'number', 0, 300],
];

const WEEKDAYS = [
  ['mon', '月'], ['tue', '火'], ['wed', '水'], ['thu', '木'],
  ['fri', '金'], ['sat', '土'], ['sun', '日'],
];

function renderSettings() {
  const s = data.settings;
  const field = ([key, label, type, min, max]) => `
    <label class="field"><span>${esc(label)}</span>
      <input type="${type}" inputmode="decimal" step="${key === 'initialRatio' ? '0.05' : '1'}"
        min="${min}" max="${max}" data-set="${key}" value="${esc(s[key])}"></label>`;

  return `
  ${topbar('設定')}

  <details class="group" open><summary>画面</summary><div class="body">
    <label class="field"><span>テーマ</span>
      <select data-set="theme">
        <option value="system" ${s.theme === 'system' ? 'selected' : ''}>端末の設定に合わせる</option>
        <option value="light" ${s.theme === 'light' ? 'selected' : ''}>ライト</option>
        <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>ダーク</option>
      </select>
    </label>
  </div></details>

  <details class="group" open><summary>進み方</summary><div class="body">
    ${SETTING_FIELDS.slice(0, 7).map(field).join('')}
    <label class="field"><span>週の開始曜日</span>
      <select data-set="weekStart">${WEEKDAYS.map(([v, n]) => `<option value="${v}" ${s.weekStart === v ? 'selected' : ''}>${n}曜</option>`).join('')}</select>
    </label>
  </div></details>

  <details class="group"><summary>テンポと音</summary><div class="body">
    <div class="grid2">
      <label class="field"><span>上げる（秒）</span><input type="number" min="0" max="60" data-tempo="up" value="${esc(s.tempo.up)}"></label>
      <label class="field"><span>下げる（秒）</span><input type="number" min="0" max="60" data-tempo="down" value="${esc(s.tempo.down)}"></label>
      <label class="field"><span>上で止める（秒）</span><input type="number" min="0" max="60" data-tempo="holdTop" value="${esc(s.tempo.holdTop)}"></label>
      <label class="field"><span>下で止める（秒）</span><input type="number" min="0" max="60" data-tempo="holdBottom" value="${esc(s.tempo.holdBottom)}"></label>
    </div>
    <div class="row between" style="margin-bottom:12px">
      <span>音を鳴らす</span>
      <input type="checkbox" data-sound="enabled" ${s.sound.enabled ? 'checked' : ''} style="width:22px">
    </div>
    <label class="field"><span>音量</span><input type="range" min="0" max="1" step="0.05" data-sound="volume" value="${esc(s.sound.volume)}"></label>
    ${field(SETTING_FIELDS[7])}
    <button class="btn small" data-act="test-sound">音を確認する</button>
  </div></details>

  <details class="group"><summary>現在のステップ・級</summary><div class="body">
    <p class="small muted">手動で修正すると、その内容がステップ変更イベントとして記録されます。</p>
    ${data.exercises
      .map((e) => {
        const step = L.currentStep(data, e.id);
        const level = L.currentLevel(data, e.id);
        return `<div class="row" style="margin-bottom:10px">
          <span style="flex:1">${esc(e.name)}</span>
          <select data-cur="${e.id}:step" style="width:6.5em">${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${i + 1 === step ? 'selected' : ''}>Step${i + 1}</option>`).join('')}</select>
          <select data-cur="${e.id}:level" style="width:6em">${[1, 2, 3].map((l) => `<option value="${l}" ${l === level ? 'selected' : ''}>${L.LEVEL_NAMES[l]}</option>`).join('')}</select>
        </div>`;
      })
      .join('')}
  </div></details>

  <details class="group"><summary>種目の開始フェーズ</summary><div class="body">
    ${data.exercises
      .map(
        (e) => `<div class="row" style="margin-bottom:10px">
          <span style="flex:1">${esc(e.name)}</span>
          <select data-phase="${e.id}" style="width:8em">
            <option value="down" ${e.startPhase === 'down' ? 'selected' : ''}>下げる から</option>
            <option value="up" ${e.startPhase === 'up' ? 'selected' : ''}>上げる から</option>
          </select>
        </div>`
      )
      .join('')}
  </div></details>

  <details class="group"><summary>ステップマスタ</summary><div class="body">
    <p class="small muted">基準値・ステップ名・単位・カウント方式・片側種目の設定を編集します。</p>
    <button class="btn small" data-act="standards">編集する</button>
  </div></details>

  <details class="group"><summary>アプリ</summary><div class="body stack">
    ${appSection()}
  </div></details>

  <details class="group"><summary>データ</summary><div class="body stack">
    <button class="btn block" data-act="reload-template">ステップマスタをテンプレートから読み込む</button>
    <button class="btn block" data-act="export">JSON をエクスポート</button>
    <button class="btn block" data-act="import">JSON をインポート</button>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <button class="btn block danger ghost" data-act="reset">すべてのデータを削除</button>
  </div></details>
  <div style="height:32px"></div>`;
}

/** 設定 →「アプリ」。ホーム画面への追加とオフライン動作の状態を示す */
function appSection() {
  const p = pwaState;
  const lines = [];

  if (p.standalone) lines.push('ホーム画面から起動しています。');
  else if (p.canInstall) lines.push('ホーム画面に追加すると、ブラウザの UI なしで起動できます。');
  else lines.push('ブラウザのメニュー（iOS は共有 →「ホーム画面に追加」）から、ホーム画面に追加できます。');

  lines.push(
    p.supported
      ? '一度開いたあとは、圏外・機内モードでも起動できます。'
      : 'この環境ではオフライン動作は使えません（HTTPS での配信が必要）。'
  );

  return `
    <p class="small muted" style="margin:0">${lines.map(esc).join('<br>')}</p>
    ${p.canInstall ? '<button class="btn block primary" data-act="install">ホーム画面に追加</button>' : ''}
    ${p.updateReady ? '<button class="btn block" data-act="apply-update">新しい版に更新する</button>' : ''}`;
}

// ────────────────────────────────────────────────────────────
// ステップマスタの編集（初回の一括入力を兼ねる）
// ────────────────────────────────────────────────────────────

function renderStandardsEditor() {
  const openId = view.ex ?? data.exercises[0]?.id;
  return `
  ${topbar('ステップマスタ')}
  <p class="small muted">書籍を参照して基準値を入力してください。入力した値は自動で保存されます。</p>
  ${data.exercises.map((e) => stdGroup(e, e.id === openId)).join('')}
  <div style="height:32px"></div>`;
}

function stdGroup(ex, open) {
  const steps = Array.from({ length: 10 }, (_, i) => stdRow(ex.id, i + 1));
  const filled = Array.from({ length: 10 }, (_, i) => L.isStandardFilled(L.getStandard(data, ex.id, i + 1))).filter(Boolean).length;
  return `<details class="group" ${open ? 'open' : ''}>
    <summary>${esc(ex.name)} <span class="small muted">（${filled}/10 入力済み）</span></summary>
    <div class="body">${steps.join('')}</div>
  </details>`;
}

function stdRow(ex, step) {
  const std = L.getStandard(data, ex, step) ?? {};
  const key = (f) => `${ex}:${step}:${f}`;
  const lv = (l) => `
    <div class="lv-row">
      <span class="lv-name">${L.LEVEL_NAMES[l]}</span>
      <input type="number" inputmode="numeric" placeholder="セット" data-std="${key(`levels.${l}.sets`)}" value="${std.levels?.[l]?.sets ?? ''}">
      <span class="times">×</span>
      <input type="number" inputmode="numeric" placeholder="${std.unit === 'sec' ? '秒' : '回'}" data-std="${key(`levels.${l}.value`)}" value="${std.levels?.[l]?.value ?? ''}">
    </div>`;
  return `<div class="card" style="background:var(--surface-2)">
    <div class="row" style="margin-bottom:8px">
      <span class="stepno">Step${step}</span>
      <input type="text" data-std="${key('name')}" value="${esc(std.name ?? '')}" placeholder="ステップ名">
    </div>
    <div class="row" style="margin-bottom:10px">
      <select data-std="${key('unit')}" style="width:7em">
        <option value="reps" ${std.unit === 'reps' ? 'selected' : ''}>回数</option>
        <option value="sec" ${std.unit === 'sec' ? 'selected' : ''}>秒数</option>
      </select>
      <select data-std="${key('mode')}" style="width:9em">
        <option value="rep" ${std.mode === 'rep' ? 'selected' : ''}>テンポ</option>
        <option value="hold" ${std.mode === 'hold' ? 'selected' : ''}>保持</option>
        <option value="free" ${std.mode === 'free' ? 'selected' : ''}>カウントなし</option>
      </select>
      <label class="row small" style="gap:6px"><input type="checkbox" data-std="${key('perSide')}" ${std.perSide ? 'checked' : ''}>片側</label>
    </div>
    <textarea class="desc" rows="2" data-std="${key('description')}"
      placeholder="実行画面に出す説明（任意）">${esc(std.description ?? '')}</textarea>
    ${[1, 2, 3].map(lv).join('')}
  </div>`;
}

function setStdField(path, value) {
  const [ex, step, field] = path.split(':');
  const std = data.steps[ex][step];
  if (field.startsWith('levels.')) {
    const [, l, f] = field.split('.');
    std.levels[l][f] = value === '' || value == null ? null : Math.max(0, num(value));
  } else if (field === 'perSide') {
    std.perSide = !!value;
  } else {
    std[field] = value;
  }
  save();
}

// ────────────────────────────────────────────────────────────
// ステップ変更
// ────────────────────────────────────────────────────────────

function changeStep(ex, to, type) {
  const from = L.currentStep(data, ex);
  if (from === to) return;
  data.stepEvents.push({ date: L.toDateStr(), exercise: ex, from, to, type });
  save();
}

// ────────────────────────────────────────────────────────────
// エクスポート／インポート
// ────────────────────────────────────────────────────────────

function exportJson() {
  const blob = new Blob([store.export()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prisoner-training-${L.toDateStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      data = store.import(String(reader.result));
      audio.configure(data.settings.sound);
      alert('インポートしました');
      go('home');
    } catch (e) {
      alert(`インポートに失敗しました: ${e.message}`);
    }
  };
  reader.readAsText(file);
}

// ────────────────────────────────────────────────────────────
// イベント
// ────────────────────────────────────────────────────────────

const actions = {
  home: () => go('home'),
  progress: () => go('progress'),
  settings: () => go('settings'),
  standards: (el) => go('standards', { ex: el.dataset.ex }),
  'close-modal': () => closeModal(),
  'modal-back': (el, ev) => {
    if (ev.target === el) closeModal();
  },

  // PWA
  'apply-update': () => pwa.applyUpdate(),
  install: async () => {
    await pwa.promptInstall();
    render();
  },

  // ホーム
  open: (el) => startRun(el.dataset.ex),
  locked: (el) => {
    const ex = el.dataset.ex;
    const meta = L.getExercise(data, ex);
    const need = data.settings.unlockStep;
    openModal(() => `
      <h2>${esc(meta.name)}</h2>
      <p class="small">ビッグフォー（プッシュアップ・スクワット・プルアップ・レッグレイズ）の
      すべてが Step${need} に到達するまでは、書籍のプログラム構成上まだ推奨されません。</p>
      <p class="small muted">現在: ${esc(
        data.exercises.filter((e) => e.group === 'big4').map((e) => `${e.name} Step${L.currentStep(data, e.id)}`).join(' / ')
      )}</p>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" data-act="unlock" data-ex="${ex}">それでも始める</button>
        <button class="btn ghost" data-act="close-modal">閉じる</button>
      </div>`);
  },
  unlock: (el) => {
    const ex = el.dataset.ex;
    if (!data.settings.manuallyUnlocked.includes(ex)) data.settings.manuallyUnlocked.push(ex);
    save();
    closeModal();
    startRun(ex);
  },
  promote: (el) => {
    const ex = el.dataset.ex;
    changeStep(ex, L.currentStep(data, ex) + 1, 'promote');
    render();
  },
  demote: (el) => {
    const ex = el.dataset.ex;
    if (!confirm('ステップを 1 つ下げます。よろしいですか？')) return;
    changeStep(ex, L.currentStep(data, ex) - 1, 'demote');
    render();
  },
  'save-quick': (el) => {
    const { ex, step } = el.dataset;
    for (const input of $$(`[data-quick^="${ex}:${step}:"]`)) {
      const [, , l, f] = input.dataset.quick.split(':');
      data.steps[ex][step].levels[l][f] = input.value === '' ? null : Math.max(0, num(input.value));
    }
    save();
    render();
  },

  // 未確定レコード
  'pending-resume': () => startRun(data.pending.exercise, { fromPending: true }),
  'pending-keep': () => {
    const p = data.pending;
    data.records.push({
      id: p.id,
      date: p.date,
      exercise: p.exercise,
      step: p.step,
      unit: p.unit,
      perSide: p.perSide,
      sets: p.sets,
      targetOfDay: p.targetOfDay,
      achieved: L.judgeAchieved(p.sets, p.targetOfDay),
    });
    data.pending = null;
    save();
    render();
  },
  'pending-discard': () => {
    if (!confirm('途中の記録を破棄します。よろしいですか？')) return;
    data.pending = null;
    save();
    render();
  },

  // 実行
  start: () => {
    audio.unlock();
    if (run.mode === 'free') {
      run.confirmValue = run.target.value ?? 0;
      run.phase = 'confirm';
    } else {
      // 構える時間を作るため、カウントの前に秒読みを挟む
      run.phase = 'countdown';
    }
    render();
  },
  'countdown-cancel': () => {
    run.countdown?.stop();
    run.countdown = null;
    run.phase = 'idle';
    render();
  },
  stop: () => {
    const r = run;
    // 回りきったレップ数をそのまま既定値にする。押下が遅れて 1 多いときは
    // 確認画面で減らす（仕様書 5.5(e)）
    r.confirmValue = r.mode === 'hold' ? r.counter.seconds() : r.counter.reps();
    r.counter.stop();
    r.counter = null;
    r.phase = 'confirm';
    render();
  },
  inc: () => setConfirmValue(run.confirmValue + 1),
  dec: () => setConfirmValue(run.confirmValue - 1),
  // 実行中に再描画するとカウンタが参照している DOM が入れ替わるため、
  // ツールチップの開閉は描画を挟まず DOM の属性だけで行う
  tip: (el) => {
    const tip = $('#step-tip');
    if (!tip) return;
    const opening = tip.hasAttribute('hidden');
    tip.toggleAttribute('hidden', !opening);
    el.setAttribute('aria-expanded', String(opening));
  },
  record: () => commitValue(run.confirmValue),
  rest: () => {
    run.phase = 'rest';
    render();
  },
  'rest-end': () => {
    run.rest?.stop();
    run.rest = null;
    run.phase = phaseAfterSet(run);
    render();
  },
  'add-set': () => {
    run.phase = 'idle';
    render();
  },
  finish: () => finishRun(),
  abort: () => {
    stopRun();
    go('home');
  },

  // 進捗
  cell: (el) => {
    view = { ...view, name: 'progress', ex: el.dataset.ex, step: num(el.dataset.step, 1) };
    render();
  },
  'cal-prev': () => {
    view = { ...view, month: L.shiftMonth(view.month ?? L.toDateStr().slice(0, 7), -1) };
    render();
  },
  'cal-next': () => {
    view = { ...view, month: L.shiftMonth(view.month ?? L.toDateStr().slice(0, 7), 1) };
    render();
  },
  'add-record': () => {
    const ex = view.ex ?? data.exercises[0].id;
    const step = view.step ?? L.currentStep(data, ex);
    const target = L.targetOfDay(data, ex) ?? { sets: null, value: null };
    openModal(recordForm({ date: L.toDateStr(), exercise: ex, step, sets: [], targetOfDay: target }));
  },
  'edit-record': (el) => {
    const rec = data.records.find((r) => r.id === el.dataset.id);
    if (rec) openModal(recordForm(rec));
  },
  'save-record': (el) => saveRecordFromForm(el.dataset.id),
  'delete-record': (el) => {
    if (!confirm('この記録を削除します。よろしいですか？')) return;
    data.records = data.records.filter((r) => r.id !== el.dataset.id);
    save();
    closeModal();
    render();
  },

  // 設定
  'test-sound': () => {
    audio.unlock();
    audio.repStart();
    setTimeout(() => audio.tick(), 400);
  },
  'reload-template': async () => {
    if (!confirm('ステップマスタ（ステップ名・説明・基準値・単位・カウント方式・片側種目・開始フェーズ）を standards.json の内容で上書きします。実施記録と設定は残ります。よろしいですか？')) return;
    try {
      const template = await fetch('./standards.json', { cache: 'no-cache' }).then((r) => r.json());
      const fresh = createInitialData(template);
      data.exercises = fresh.exercises;
      data.steps = fresh.steps;
      save();
      alert('ステップマスタを読み込みました');
      go('home');
    } catch (e) {
      alert(`読み込みに失敗しました: ${e.message}`);
    }
  },
  export: () => exportJson(),
  import: () => $('#import-file').click(),
  reset: () => {
    if (!confirm('すべてのデータを削除して初期状態に戻します。よろしいですか？')) return;
    store.clear();
    location.reload();
  },
};

function closeTip() {
  const tip = $('#step-tip');
  if (!tip || tip.hasAttribute('hidden')) return;
  tip.setAttribute('hidden', '');
  $('.tip-btn')?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  // ⓘ 以外のどこを触っても閉じる（吹き出し自身を含む。逃げ場のないタップを作らない）
  if (el?.dataset.act !== 'tip') closeTip();
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  fn(el, ev);
});

document.addEventListener('change', (ev) => {
  const el = ev.target;

  if (el.id === 'import-file' && el.files?.[0]) {
    importJson(el.files[0]);
    return;
  }
  if (el.dataset.std) {
    setStdField(el.dataset.std, el.type === 'checkbox' ? el.checked : el.value);
    return;
  }
  if (el.dataset.set) {
    const key = el.dataset.set;
    const v = key === 'weekStart' || key === 'theme' ? el.value : num(el.value, defaultSettings()[key]);
    data.settings[key] = v;
    if (key === 'theme') applyTheme();
    save();
    return;
  }
  if (el.dataset.tempo) {
    data.settings.tempo[el.dataset.tempo] = Math.max(0, num(el.value));
    save();
    return;
  }
  if (el.dataset.sound) {
    const k = el.dataset.sound;
    data.settings.sound[k] = k === 'enabled' ? el.checked : Math.max(0, Math.min(1, num(el.value, 0.7)));
    audio.configure(data.settings.sound);
    save();
    return;
  }
  if (el.dataset.phase) {
    const ex = data.exercises.find((e) => e.id === el.dataset.phase);
    if (ex) {
      ex.startPhase = el.value;
      save();
    }
    return;
  }
  if (el.dataset.cur) {
    const [ex, field] = el.dataset.cur.split(':');
    const step = field === 'step' ? num(el.value, 1) : L.currentStep(data, ex);
    const level = field === 'level' ? num(el.value, 1) : L.currentLevel(data, ex);
    changeStep(ex, step, 'manual');
    // 手動指定は「アプリ導入前の到達状況」と同じ扱いにする（4.5 の下限）
    data.initialState[ex] = { step, level };
    save();
    render();
  }
});

document.addEventListener('keydown', (ev) => {
  // 秒数入力欄などで Enter を押したときに送信されないようにする
  if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') ev.target.blur();
  if (ev.key === 'Escape') closeTip();
});

window.addEventListener('beforeunload', () => wakeLock.release());
