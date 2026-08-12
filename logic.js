/**
 * logic.js … 目標算出・昇格判定・降格判定・解禁判定
 *
 * DOM に触れない純粋関数のみを置く（テスト可能にするため）。
 */

// ────────────────────────────────────────────────────────────
// 日付ユーティリティ
// ────────────────────────────────────────────────────────────

const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Date → 'YYYY-MM-DD'（ローカル日付） */
export function toDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → ローカル 0 時の Date */
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** b - a の日数 */
export function daysBetween(a, b) {
  const ms = parseDate(b).getTime() - parseDate(a).getTime();
  return Math.round(ms / 86400000);
}

/** その日を含む週の開始日（'YYYY-MM-DD'） */
export function weekStartOf(dateStr, weekStart = 'mon') {
  const base = WEEKDAY_INDEX[weekStart] ?? 1;
  const d = parseDate(dateStr);
  const diff = (d.getDay() - base + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toDateStr(d);
}

/** from から to までの経過週数（切り捨て） */
export function weeksBetween(from, to) {
  return Math.floor(daysBetween(from, to) / 7);
}

/** 相対表示（「今日」「3日前」） */
export function relativeDay(dateStr, today = toDateStr()) {
  const n = daysBetween(dateStr, today);
  if (n <= 0) return '今日';
  if (n === 1) return '昨日';
  return `${n}日前`;
}

// ────────────────────────────────────────────────────────────
// 参照ヘルパ
// ────────────────────────────────────────────────────────────

export const LEVEL_NAMES = { 1: '初級', 2: '中級', 3: '上級' };

export function getExercise(data, ex) {
  return data.exercises.find((e) => e.id === ex) ?? null;
}

export function getStandard(data, ex, step) {
  return data.steps?.[ex]?.[String(step)] ?? null;
}

/** ステップの説明（未入力なら空文字）。実行画面のツールチップに出す */
export function stepDescription(data, ex, step) {
  return String(getStandard(data, ex, step)?.description ?? '').trim();
}

/** 級の基準値が入力済みか */
export function isLevelFilled(std, level) {
  const l = std?.levels?.[level];
  return !!l && l.sets != null && l.value != null && l.sets > 0 && l.value > 0;
}

/** 3 級すべて入力済みか */
export function isStandardFilled(std) {
  return [1, 2, 3].every((l) => isLevelFilled(std, l));
}

/** セット実績の実効値。片側種目は弱い側（低い方）を採る（仕様書 4.7） */
export function effectiveValue(entry) {
  return Array.isArray(entry) ? Math.min(entry[0], entry[1]) : entry;
}

/** レコードの並び順キー（日付 → id） */
function orderKey(r) {
  return `${r.date}#${r.id ?? ''}`;
}

function sortRecords(list) {
  return [...list].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0));
}

// ────────────────────────────────────────────────────────────
// ステップ
// ────────────────────────────────────────────────────────────

export function stepEventsFor(data, ex) {
  return sortRecords(data.stepEvents.filter((e) => e.exercise === ex));
}

/** 現在のステップ。ステップ変更イベントの最新 to、なければ初期値 */
export function currentStep(data, ex) {
  const events = stepEventsFor(data, ex);
  if (events.length) return events[events.length - 1].to;
  return data.initialState?.[ex]?.step ?? 1;
}

/**
 * 現在ステップの開始日。
 * ステップ変更イベントがあればその日付、なければ当該ステップの最初の記録日。
 * どちらもない場合は null（＝経過週数を判定できない）。
 */
export function stepStartDate(data, ex) {
  const events = stepEventsFor(data, ex);
  if (events.length) return events[events.length - 1].date;
  const recs = recordsAtCurrentStep(data, ex);
  return recs.length ? recs[0].date : null;
}

/** 現在ステップ・現在の在籍期間中のレコード（日付順） */
export function recordsAtCurrentStep(data, ex) {
  const step = currentStep(data, ex);
  const events = stepEventsFor(data, ex);
  const since = events.length ? events[events.length - 1].date : null;
  return sortRecords(
    data.records.filter(
      (r) => r.exercise === ex && r.step === step && (since === null || r.date >= since)
    )
  );
}

export function recordsFor(data, ex, step = null) {
  const list = data.records.filter((r) => r.exercise === ex && (step === null || r.step === step));
  return sortRecords(list).reverse(); // 新しい順
}

// ────────────────────────────────────────────────────────────
// 判定
// ────────────────────────────────────────────────────────────

/** 実績が「sets セット × value」を満たすか */
export function meetsCriteria(sets, criteria) {
  if (!criteria || criteria.sets == null || criteria.value == null) return false;
  const ok = sets.filter((s) => effectiveValue(s) >= criteria.value).length;
  return ok >= criteria.sets;
}

/** 目標に対する達成判定（片側種目は左右とも満たした場合のみ true） */
export function judgeAchieved(sets, target) {
  return meetsCriteria(sets, target);
}

/** そのレコードが満たした最も高い級（0 = どの級も満たさない） */
export function levelMetBy(record, std) {
  for (const l of [3, 2, 1]) {
    if (isLevelFilled(std, l) && meetsCriteria(record.sets, std.levels[l])) return l;
  }
  return 0;
}

/** セット実績の平均（目標の降格に使う）。片側種目は弱い側の平均 */
export function averageOf(record) {
  if (!record.sets.length) return 0;
  const sum = record.sets.reduce((a, s) => a + effectiveValue(s), 0);
  return Math.max(1, Math.floor(sum / record.sets.length));
}

// ────────────────────────────────────────────────────────────
// 当日目標の算出（仕様書 4.1）と級の判定（4.5）
// ────────────────────────────────────────────────────────────

/**
 * 現在ステップの履歴を先頭からたどり、級・当日目標・目標降格の回数を求める。
 *
 * 級の初期値（initialState.level）は下限として扱うが、それが効くのは
 * 「初期値のステップに在籍していて、まだ一度もステップを移動していない」間だけとする。
 * ステップが変われば動作自体が変わり、アプリ導入前の到達状況は引き継げないため。
 */
export function simulate(data, ex) {
  const step = currentStep(data, ex);
  const std = getStandard(data, ex, step);
  const s = data.settings;
  const init = data.initialState?.[ex] ?? { step: 1, level: 1 };
  const events = stepEventsFor(data, ex);
  const lastEvent = events.length ? events[events.length - 1] : null;
  // 手動変更は「アプリ導入前の到達状況の申告」として扱い、昇格直後の係数を適用しない
  const afterChange = !!lastEvent && lastEvent.type !== 'manual';

  const result = { step, std, level: 1, target: null, demoteCount: 0, ready: false };
  if (!std || !isLevelFilled(std, 1)) return result; // 基準値未入力

  let level = afterChange || init.step !== step ? 1 : Math.min(3, Math.max(1, init.level));
  // 級の基準が未入力なら、入力済みの最も高い級まで下げる
  while (level > 1 && !isLevelFilled(std, level)) level--;

  let target;
  if (afterChange) {
    // (a) ステップ昇格・降格の直後
    const l1 = std.levels[1];
    target = { sets: l1.sets, value: Math.max(1, Math.floor(l1.value * s.initialRatio)) };
  } else {
    // (d) 履歴がない場合
    const l = std.levels[level];
    target = { sets: l.sets, value: l.value };
  }

  const increment = std.unit === 'sec' ? s.secIncrement : s.maxIncrement;
  let demoteCount = 0;
  let prevFailed = false;

  for (const rec of recordsAtCurrentStep(data, ex)) {
    const met = levelMetBy(rec, std);
    const nextLevel = met >= 1 ? Math.min(3, met + 1) : level;

    if (met >= level && nextLevel > level && isLevelFilled(std, nextLevel)) {
      // (b) 級の移行：前の級の総量を新しいセット数で割り直す
      const prev = std.levels[met];
      const next = std.levels[nextLevel];
      let value = Math.max(1, Math.floor((prev.value * prev.sets) / next.sets));
      if (value > next.value) value = next.value; // 入力ミスに対する保険（仕様書 4.1(b)）
      target = { sets: next.sets, value };
      level = nextLevel;
      prevFailed = false;
      continue;
    }

    // (c) 通常の漸進
    // 漸進の基準は「そのとき実際に提示した目標」。基準値をあとから直しても
    // 過去に提示した目標を計算し直さないため（仕様書 4.1 の遡及入力に関する補足）。
    const base = rec.targetOfDay?.value != null ? rec.targetOfDay : target;
    const cap = std.levels[level];
    if (rec.achieved) {
      let value = base.value + increment;
      if (cap.value != null && value > cap.value) value = cap.value;
      target = { sets: cap.sets ?? base.sets, value };
      prevFailed = false;
    } else if (prevFailed) {
      // 直近 2 回連続で未達 → 前回実績の平均値まで目標を下げる
      target = { sets: base.sets, value: averageOf(rec) };
      demoteCount++;
    } else {
      target = { sets: base.sets, value: base.value };
      prevFailed = true;
    }
  }

  result.level = level;
  result.target = target;
  result.demoteCount = demoteCount;
  result.ready = true;
  return result;
}

/** 現在の級（仕様書 4.5） */
export function currentLevel(data, ex) {
  return simulate(data, ex).level;
}

/** 当日目標（仕様書 4.1）。基準値未入力なら null */
export function targetOfDay(data, ex) {
  return simulate(data, ex).target;
}

// ────────────────────────────────────────────────────────────
// 昇格・降格・解禁
// ────────────────────────────────────────────────────────────

/** 昇格提案の判定（仕様書 4.2） */
export function promotionStatus(data, ex, today = toDateStr()) {
  const step = currentStep(data, ex);
  const std = getStandard(data, ex, step);
  const s = data.settings;
  const recs = recordsAtCurrentStep(data, ex);
  const count = std ? recs.filter((r) => levelMetBy(r, std) >= 3).length : 0;
  const start = stepStartDate(data, ex);
  const weeks = start ? weeksBetween(start, today) : 0;
  const ok =
    step < 10 &&
    !!std &&
    isLevelFilled(std, 3) &&
    count >= s.promotionCount &&
    weeks >= s.minWeeksPerStep;
  return { count, need: s.promotionCount, weeks, needWeeks: s.minWeeksPerStep, ok };
}

/** 降格提案の判定（仕様書 4.6） */
export function demotionStatus(data, ex) {
  const step = currentStep(data, ex);
  const { demoteCount } = simulate(data, ex);
  const need = data.settings.demoteThreshold;
  return { count: demoteCount, need, ok: step > 1 && demoteCount >= need };
}

/** 解禁判定（仕様書 4.3） */
export function isUnlocked(data, ex) {
  const meta = getExercise(data, ex);
  if (!meta || meta.group !== 'late') return true;
  if (data.settings.manuallyUnlocked.includes(ex)) return true;
  const big4 = data.exercises.filter((e) => e.group === 'big4');
  return big4.every((e) => currentStep(data, e.id) >= data.settings.unlockStep);
}

// ────────────────────────────────────────────────────────────
// 週の集計（仕様書 4.4）
// ────────────────────────────────────────────────────────────

export function weekCount(data, ex, today = toDateStr()) {
  const start = weekStartOf(today, data.settings.weekStart);
  return data.records.filter((r) => r.exercise === ex && r.date >= start && r.date <= today).length;
}

export function weekTotal(data, today = toDateStr()) {
  const start = weekStartOf(today, data.settings.weekStart);
  return data.records.filter((r) => r.date >= start && r.date <= today).length;
}

export function lastDateOf(data, ex) {
  const recs = recordsFor(data, ex);
  return recs.length ? recs[0].date : null;
}

// ────────────────────────────────────────────────────────────
// 画面向けのまとめ
// ────────────────────────────────────────────────────────────

/** ホーム／実行画面が必要とする種目の状態を一度に返す */
export function exerciseState(data, ex, today = toDateStr()) {
  const meta = getExercise(data, ex);
  const step = currentStep(data, ex);
  const std = getStandard(data, ex, step);
  const sim = simulate(data, ex);
  return {
    id: ex,
    name: meta?.name ?? ex,
    group: meta?.group ?? 'big4',
    startPhase: meta?.startPhase ?? 'down',
    step,
    stepName: std?.name ?? `Step${step}`,
    description: stepDescription(data, ex, step),
    std,
    unit: std?.unit ?? 'reps',
    mode: std?.mode ?? 'rep',
    perSide: std?.perSide ?? false,
    level: sim.level,
    target: sim.target,
    ready: sim.ready,
    weekCount: weekCount(data, ex, today),
    lastDate: lastDateOf(data, ex),
    unlocked: isUnlocked(data, ex),
    promotion: promotionStatus(data, ex, today),
    demotion: demotionStatus(data, ex),
  };
}

/** ホームの並び順：今週の実施回数が少ない順 → 前回実施日が古い順 */
export function homeOrder(states) {
  return [...states].sort((a, b) => {
    if (a.weekCount !== b.weekCount) return a.weekCount - b.weekCount;
    const ad = a.lastDate ?? '0000-00-00';
    const bd = b.lastDate ?? '0000-00-00';
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
}

/** 進捗グリッド 1 マスの状態 */
export function gridCell(data, ex, step, today = toDateStr()) {
  const cur = currentStep(data, ex);
  const std = getStandard(data, ex, step);
  const recs = data.records.filter((r) => r.exercise === ex && r.step === step);
  if (step === cur) {
    const sim = simulate(data, ex);
    const promo = promotionStatus(data, ex, today);
    return {
      state: promo.ok ? 'promotable' : 'current',
      level: sim.level,
      fill: levelFill(data, ex, sim, std),
      current: true,
      count: recs.length,
    };
  }
  if (step < cur) return { state: 'done', level: 3, fill: 1, current: false, count: recs.length };
  if (recs.length) return { state: 'past', level: 1, fill: 1, current: false, count: recs.length };
  return { state: 'empty', level: 0, fill: 0, current: false, count: 0 };
}

/** 級内の進捗（0〜1）。当日目標が現在の級の基準値に対してどこまで来ているか */
function levelFill(data, ex, sim, std) {
  if (!sim.ready || !std) return 0;
  const cap = std.levels[sim.level];
  if (!cap || !cap.value) return 0;
  return Math.max(0, Math.min(1, sim.target.value / cap.value));
}

// ────────────────────────────────────────────────────────────
// テンポ（仕様書 5.5(a)）
// ────────────────────────────────────────────────────────────

const PHASE_LABEL = { down: '下げる', up: '上げる', holdTop: '上で止める', holdBottom: '下で止める' };

/** 開始フェーズからテンポの再生順を組み立てる */
export function phaseSequence(startPhase, tempo) {
  const order =
    startPhase === 'up'
      ? ['up', 'holdTop', 'down', 'holdBottom']
      : ['down', 'holdBottom', 'up', 'holdTop'];
  return order
    .map((key) => ({ key, label: PHASE_LABEL[key], sec: Math.max(0, Number(tempo[key]) || 0) }))
    .filter((p) => p.sec > 0);
}

export function tempoText(startPhase, tempo) {
  return phaseSequence(startPhase, tempo)
    .map((p) => `${p.label.replace('る', '')}${p.sec}`)
    .join(' - ');
}

/** 1 レップの秒数 */
export function repDuration(startPhase, tempo) {
  return phaseSequence(startPhase, tempo).reduce((a, p) => a + p.sec, 0);
}

// ────────────────────────────────────────────────────────────
// 表示整形
// ────────────────────────────────────────────────────────────

export function unitLabel(unit) {
  return unit === 'sec' ? '秒' : '回';
}

/** 「2セット × 左右各10回」 */
export function targetText(target, unit, perSide) {
  if (!target || target.value == null) return '—';
  const u = unitLabel(unit);
  return perSide
    ? `${target.sets}セット × 左右各${target.value}${u}`
    : `${target.sets}セット × ${target.value}${u}`;
}

/** 「2×(10/9), (10/8)」 */
export function setsText(sets, perSide) {
  if (!sets?.length) return '—';
  return sets.map((s) => (perSide || Array.isArray(s) ? `(${s[0]}/${s[1]})` : String(s))).join(', ');
}

/** 記録 id の採番：日付 + 種目 + 連番 */
export function nextRecordId(records, date, ex) {
  const n = records.filter((r) => r.date === date && r.exercise === ex).length + 1;
  let id = `${date}-${ex}-${n}`;
  let i = n;
  while (records.some((r) => r.id === id)) {
    i++;
    id = `${date}-${ex}-${i}`;
  }
  return id;
}
