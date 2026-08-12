import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../logic.js';
import { defaultSettings, defaultInitialState } from '../store.js';

// ────────────────────────────────────────────────────────────
// テスト用データ
// ────────────────────────────────────────────────────────────

const EXERCISES = [
  { id: 'pushup', name: 'プッシュアップ', group: 'big4', startPhase: 'down' },
  { id: 'squat', name: 'スクワット', group: 'big4', startPhase: 'down' },
  { id: 'pullup', name: 'プルアップ', group: 'big4', startPhase: 'up' },
  { id: 'legraise', name: 'レッグレイズ', group: 'big4', startPhase: 'up' },
  { id: 'bridge', name: 'ブリッジ', group: 'late', startPhase: 'up' },
  { id: 'handstand', name: 'ハンドスタンド', group: 'late', startPhase: 'down' },
];

/** 全種目・全ステップに同じ基準値を入れたデータを作る */
function makeData(overrides = {}) {
  const steps = {};
  for (const ex of EXERCISES) {
    steps[ex.id] = {};
    for (let s = 1; s <= 10; s++) {
      steps[ex.id][String(s)] = {
        name: `Step${s}`,
        unit: 'reps',
        mode: 'rep',
        perSide: false,
        levels: {
          1: { sets: 1, value: 30 },
          2: { sets: 2, value: 20 },
          3: { sets: 3, value: 25 },
        },
      };
    }
  }
  return {
    exercises: EXERCISES.map((e) => ({ ...e })),
    steps,
    initialState: defaultInitialState(),
    settings: defaultSettings(),
    records: [],
    stepEvents: [],
    pending: null,
    ...overrides,
  };
}

function rec(date, exercise, step, sets, target, achieved) {
  return {
    id: `${date}-${exercise}-1`,
    date,
    exercise,
    step,
    unit: 'reps',
    perSide: Array.isArray(sets[0]),
    sets,
    targetOfDay: target,
    achieved,
  };
}

// ────────────────────────────────────────────────────────────
// 日付
// ────────────────────────────────────────────────────────────

test('週の開始日は設定した曜日に丸められる', () => {
  assert.equal(L.weekStartOf('2026-08-12', 'mon'), '2026-08-10'); // 水 → 月
  assert.equal(L.weekStartOf('2026-08-10', 'mon'), '2026-08-10');
  assert.equal(L.weekStartOf('2026-08-12', 'sun'), '2026-08-09');
});

test('経過週数は切り捨て', () => {
  assert.equal(L.weeksBetween('2026-08-01', '2026-08-28'), 3);
  assert.equal(L.weeksBetween('2026-08-01', '2026-08-29'), 4);
});

// ────────────────────────────────────────────────────────────
// 4.1 当日目標
// ────────────────────────────────────────────────────────────

test('(d) 履歴がなければ初期状態の級の基準値が目標になる', () => {
  const data = makeData();
  // pushup は初期値 step3 / 中級
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 20 });
  assert.equal(L.currentLevel(data, 'pushup'), 2);
  // squat は初期値 step2 / 初級
  assert.deepEqual(L.targetOfDay(data, 'squat'), { sets: 1, value: 30 });
});

test('(a) ステップ昇格の直後は新ステップ初級基準の 8 割', () => {
  const data = makeData();
  data.stepEvents.push({ date: '2026-08-01', exercise: 'pushup', from: 3, to: 4, type: 'promote' });
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 1, value: 24 }); // floor(30 * 0.8)
  assert.equal(L.currentLevel(data, 'pushup'), 1);
});

test('(a) 手動変更では係数を適用せず、指定した級の基準値を目標にする', () => {
  const data = makeData();
  data.stepEvents.push({ date: '2026-08-01', exercise: 'squat', from: 2, to: 5, type: 'manual' });
  data.initialState.squat = { step: 5, level: 2 };
  assert.deepEqual(L.targetOfDay(data, 'squat'), { sets: 2, value: 20 });
});

test('(b) 級の移行では前の級の総量を新しいセット数で割り直す', () => {
  const data = makeData();
  data.initialState.squat = { step: 2, level: 1 };
  // 初級 1×30 を達成
  data.records.push(rec('2026-08-01', 'squat', 2, [30], { sets: 1, value: 30 }, true));
  assert.deepEqual(L.targetOfDay(data, 'squat'), { sets: 2, value: 15 }); // floor(30*1/2)
  assert.equal(L.currentLevel(data, 'squat'), 2);
});

test('(b) 算出値が新しい級の基準値を超える場合はクランプする', () => {
  const data = makeData();
  // 入力ミスで中級の総量が初級を下回るケース
  for (const s of Object.values(data.steps.squat)) {
    s.levels[1] = { sets: 1, value: 30 };
    s.levels[2] = { sets: 2, value: 10 };
  }
  data.initialState.squat = { step: 2, level: 1 };
  data.records.push(rec('2026-08-01', 'squat', 2, [30], { sets: 1, value: 30 }, true));
  assert.deepEqual(L.targetOfDay(data, 'squat'), { sets: 2, value: 10 });
});

test('(c) 達成すれば増加し、現在の級の基準値でクランプされる', () => {
  const data = makeData();
  data.initialState.pushup = { step: 3, level: 2 }; // 中級 2×20
  data.records.push(rec('2026-08-01', 'pushup', 3, [17, 17], { sets: 2, value: 17 }, true));
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 19 }); // 17 + 2

  data.records.push(rec('2026-08-04', 'pushup', 3, [19, 19], { sets: 2, value: 19 }, true));
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 20 }); // 21 → 中級 20 でクランプ
});

test('(c) 1 回の未達では据え置き、2 回連続で平均まで下げる', () => {
  const data = makeData();
  data.initialState.pushup = { step: 3, level: 2 };
  data.records.push(rec('2026-08-01', 'pushup', 3, [18, 16], { sets: 2, value: 20 }, false));
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 20 });

  data.records.push(rec('2026-08-04', 'pushup', 3, [15, 14], { sets: 2, value: 20 }, false));
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 14 }); // floor((15+14)/2)
});

test('秒数系は secIncrement で増える', () => {
  const data = makeData();
  for (const s of Object.values(data.steps.bridge)) {
    s.unit = 'sec';
    s.mode = 'hold';
    s.levels = { 1: { sets: 1, value: 60 }, 2: { sets: 2, value: 45 }, 3: { sets: 3, value: 60 } };
  }
  data.records.push(rec('2026-08-01', 'bridge', 1, [30], { sets: 1, value: 30 }, true));
  assert.deepEqual(L.targetOfDay(data, 'bridge'), { sets: 1, value: 35 });
});

// ────────────────────────────────────────────────────────────
// 4.7 片側種目
// ────────────────────────────────────────────────────────────

test('片側種目は弱い側で判定する', () => {
  assert.equal(L.judgeAchieved([[10, 9], [10, 8]], { sets: 2, value: 10 }), false);
  assert.equal(L.judgeAchieved([[10, 10], [11, 10]], { sets: 2, value: 10 }), true);
  assert.equal(L.effectiveValue([10, 8]), 8);
});

test('片側種目の漸進も弱い側を基準にする', () => {
  const data = makeData();
  for (const s of Object.values(data.steps.pushup)) s.perSide = true;
  data.initialState.pushup = { step: 3, level: 2 };
  data.records.push(rec('2026-08-01', 'pushup', 3, [[12, 10], [11, 10]], { sets: 2, value: 12 }, false));
  data.records.push(rec('2026-08-04', 'pushup', 3, [[12, 9], [12, 11]], { sets: 2, value: 12 }, false));
  // 弱い側の平均 floor((10+11)/2) = 10
  assert.deepEqual(L.targetOfDay(data, 'pushup'), { sets: 2, value: 10 });
});

// ────────────────────────────────────────────────────────────
// 4.2 / 4.6 昇格・降格
// ────────────────────────────────────────────────────────────

test('昇格提案は上級 4 回以上かつ 4 週以上で成立する', () => {
  const data = makeData();
  data.initialState.squat = { step: 2, level: 1 };
  const dates = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'];
  for (const d of dates) {
    data.records.push(rec(d, 'squat', 2, [25, 25, 25], { sets: 3, value: 25 }, true));
  }
  // 3 回時点では成立しない
  const partial = makeData();
  partial.records = data.records.slice(0, 3);
  assert.equal(L.promotionStatus(partial, 'squat', '2026-08-12').ok, false);

  // 4 回 + 6 週経過で成立
  assert.equal(L.promotionStatus(data, 'squat', '2026-08-12').ok, true);
  // 週数が足りなければ成立しない
  assert.equal(L.promotionStatus(data, 'squat', '2026-07-23').ok, false);
});

test('降格提案は目標降格が 2 回で成立する', () => {
  const data = makeData();
  data.initialState.pushup = { step: 3, level: 2 };
  const fails = ['2026-08-01', '2026-08-04', '2026-08-07', '2026-08-10'];
  for (const d of fails) {
    data.records.push(rec(d, 'pushup', 3, [10, 10], { sets: 2, value: 20 }, false));
  }
  // 2 回目・3 回目・4 回目の未達でそれぞれ目標が下がる
  const st = L.demotionStatus(data, 'pushup');
  assert.equal(st.count >= 2, true);
  assert.equal(st.ok, true);
});

// ────────────────────────────────────────────────────────────
// 4.3 解禁
// ────────────────────────────────────────────────────────────

test('ブリッジはビッグフォーが全て Step5 以上になるまで推奨されない', () => {
  const data = makeData();
  assert.equal(L.isUnlocked(data, 'bridge'), false);
  assert.equal(L.isUnlocked(data, 'pushup'), true);

  for (const ex of ['pushup', 'squat', 'pullup', 'legraise']) {
    data.stepEvents.push({ date: '2026-08-01', exercise: ex, from: 1, to: 5, type: 'manual' });
  }
  assert.equal(L.isUnlocked(data, 'bridge'), true);
});

test('手動で有効化した種目は常に表示される', () => {
  const data = makeData();
  data.settings.manuallyUnlocked = ['handstand'];
  assert.equal(L.isUnlocked(data, 'handstand'), true);
  assert.equal(L.isUnlocked(data, 'bridge'), false);
});

// ────────────────────────────────────────────────────────────
// 4.4 週の集計・並び順
// ────────────────────────────────────────────────────────────

test('週の実施回数は週開始日以降のレコードを数える', () => {
  const data = makeData();
  data.records.push(rec('2026-08-09', 'pushup', 3, [20], { sets: 1, value: 20 }, true)); // 前週（日）
  data.records.push(rec('2026-08-10', 'pushup', 3, [20], { sets: 1, value: 20 }, true)); // 当週（月）
  data.records.push(rec('2026-08-12', 'pushup', 3, [20], { sets: 1, value: 20 }, true));
  assert.equal(L.weekCount(data, 'pushup', '2026-08-12'), 2);
  assert.equal(L.weekTotal(data, '2026-08-12'), 2);
});

test('ホームの並び順は今週の回数が少ない順、次に前回実施日が古い順', () => {
  const states = [
    { id: 'a', weekCount: 1, lastDate: '2026-08-10' },
    { id: 'b', weekCount: 0, lastDate: '2026-08-05' },
    { id: 'c', weekCount: 0, lastDate: '2026-08-01' },
  ];
  assert.deepEqual(L.homeOrder(states).map((s) => s.id), ['c', 'b', 'a']);
});

// ────────────────────────────────────────────────────────────
// 5.5 テンポ
// ────────────────────────────────────────────────────────────

test('開始フェーズから再生順が決まる', () => {
  const tempo = { up: 2, down: 2, holdTop: 1, holdBottom: 1 };
  assert.deepEqual(L.phaseSequence('down', tempo).map((p) => p.key), ['down', 'holdBottom', 'up', 'holdTop']);
  assert.deepEqual(L.phaseSequence('up', tempo).map((p) => p.key), ['up', 'holdTop', 'down', 'holdBottom']);
  assert.equal(L.repDuration('down', tempo), 6);
});

test('0 秒のフェーズは再生順から除かれる', () => {
  const tempo = { up: 2, down: 2, holdTop: 0, holdBottom: 1 };
  assert.deepEqual(L.phaseSequence('down', tempo).map((p) => p.key), ['down', 'holdBottom', 'up']);
});

// ────────────────────────────────────────────────────────────
// 表示整形
// ────────────────────────────────────────────────────────────

test('目標の表示は片側種目を明示する', () => {
  assert.equal(L.targetText({ sets: 2, value: 15 }, 'reps', false), '15回 × 2セット');
  assert.equal(L.targetText({ sets: 2, value: 10 }, 'reps', true), '左右各10回 × 2セット');
  assert.equal(L.targetText({ sets: 1, value: 60 }, 'sec', false), '60秒 × 1セット');
});

test('実績の表示は片側種目を (左/右) にする', () => {
  assert.equal(L.setsText([20, 20, 18], false), '20, 20, 18');
  assert.equal(L.setsText([[10, 9], [10, 8]], true), '(10/9), (10/8)');
});

test('ステップの説明は未入力なら空文字を返す', () => {
  const data = makeData();
  assert.equal(L.stepDescription(data, 'pushup', 3), '');

  data.steps.pushup['3'].description = '  膝をついて、体を一直線に保つ  ';
  assert.equal(L.stepDescription(data, 'pushup', 3), '膝をついて、体を一直線に保つ');
  assert.equal(L.exerciseState(data, 'pushup').description, '膝をついて、体を一直線に保つ');

  // 存在しないステップでも落ちない
  assert.equal(L.stepDescription(data, 'pushup', 99), '');
  assert.equal(L.stepDescription(data, 'unknown', 1), '');
});

test('説明が空白のみなら未入力として扱う', () => {
  const data = makeData();
  data.steps.squat['2'].description = '   \n  ';
  assert.equal(L.stepDescription(data, 'squat', 2), '');
});

test('standards.json は全 60 ステップに説明の既定値を持つ', () => {
  const url = new URL('../standards.json', import.meta.url);
  const template = JSON.parse(readFileSync(url, 'utf8'));
  for (const ex of EXERCISES) {
    for (let s = 1; s <= 10; s++) {
      const std = template.steps?.[ex.id]?.[String(s)];
      assert.ok(std, `${ex.id} Step${s} がテンプレートにない`);
      assert.ok(
        String(std.description ?? '').trim() !== '',
        `${ex.id} Step${s} の説明が未入力`
      );
    }
  }
});

test('記録 id は日付・種目ごとに連番になる', () => {
  const records = [{ id: '2026-08-12-pushup-1', date: '2026-08-12', exercise: 'pushup' }];
  assert.equal(L.nextRecordId(records, '2026-08-12', 'pushup'), '2026-08-12-pushup-2');
  assert.equal(L.nextRecordId(records, '2026-08-12', 'squat'), '2026-08-12-squat-1');
});
