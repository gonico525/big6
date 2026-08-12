/**
 * store.js … 保存の抽象化
 *
 * localStorage への直接アクセスはこのファイルに閉じ込める。
 * Capacitor でのネイティブ化時は、この 3 関数（load / save / export）の
 * 実装だけを差し替えれば済むようにしておく（仕様書 6.3）。
 */

const KEY = 'prisoner-training-app';
export const SCHEMA_VERSION = 1;

/** 設定の初期値（仕様書 3.8） */
export function defaultSettings() {
  return {
    unlockStep: 5,
    maxIncrement: 2,
    secIncrement: 5,
    initialRatio: 0.8,
    promotionCount: 4,
    minWeeksPerStep: 4,
    demoteThreshold: 2,
    weekStart: 'mon',
    tempo: { up: 2, down: 2, holdTop: 1, holdBottom: 1 },
    sound: { enabled: true, volume: 0.7 },
    restBeepInterval: 10,
    manuallyUnlocked: [],
  };
}

/** 初期状態の既定値（仕様書 3.7）。設定画面から変更できる。 */
export function defaultInitialState() {
  return {
    pushup: { step: 3, level: 2 },
    squat: { step: 2, level: 1 },
    pullup: { step: 3, level: 1 },
    legraise: { step: 2, level: 1 },
    bridge: { step: 1, level: 1 },
    handstand: { step: 1, level: 1 },
  };
}

/**
 * standards.json のテンプレートから保存データの初期形を作る。
 * テンプレートは初期値の供給源としてのみ使い、以降は保存領域の値が正となる。
 */
export function createInitialData(template) {
  const exercises = template.exercises.map((e) => ({ ...e }));
  const steps = {};
  for (const ex of exercises) {
    steps[ex.id] = {};
    for (let s = 1; s <= 10; s++) {
      const src = template.steps?.[ex.id]?.[String(s)] ?? {};
      steps[ex.id][String(s)] = {
        name: src.name ?? `Step${s}`,
        description: src.description ?? '',
        unit: src.unit ?? 'reps',
        mode: src.mode ?? 'rep',
        perSide: src.perSide ?? false,
        levels: {
          1: { sets: src.levels?.[1]?.sets ?? null, value: src.levels?.[1]?.value ?? null },
          2: { sets: src.levels?.[2]?.sets ?? null, value: src.levels?.[2]?.value ?? null },
          3: { sets: src.levels?.[3]?.sets ?? null, value: src.levels?.[3]?.value ?? null },
        },
      };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    exercises,
    steps,
    initialState: defaultInitialState(),
    settings: defaultSettings(),
    records: [],
    stepEvents: [],
    pending: null,
  };
}

/** 読み込み時に欠けているキーを既定値で埋める（版が上がったときの保険） */
function migrate(data) {
  if (!data || typeof data !== 'object') return null;
  const d = { ...data };
  d.schemaVersion = SCHEMA_VERSION;
  d.settings = { ...defaultSettings(), ...(d.settings ?? {}) };
  d.settings.tempo = { ...defaultSettings().tempo, ...(d.settings.tempo ?? {}) };
  d.settings.sound = { ...defaultSettings().sound, ...(d.settings.sound ?? {}) };
  if (!Array.isArray(d.settings.manuallyUnlocked)) d.settings.manuallyUnlocked = [];
  d.initialState = { ...defaultInitialState(), ...(d.initialState ?? {}) };
  d.records = Array.isArray(d.records) ? d.records : [];
  d.stepEvents = Array.isArray(d.stepEvents) ? d.stepEvents : [];
  d.exercises = Array.isArray(d.exercises) ? d.exercises : [];
  d.steps = d.steps ?? {};
  if (d.pending === undefined) d.pending = null;
  return d;
}

export const store = {
  /** 全データの読み込み。未保存なら null */
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.error('store.load failed', e);
      return null;
    }
  },

  /** 全データの保存 */
  save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('store.save failed', e);
      return false;
    }
  },

  /** JSON 文字列の出力 */
  export() {
    const data = this.load();
    return JSON.stringify(data ?? {}, null, 2);
  },

  /** JSON 文字列の取り込み。壊れた入力は例外を投げる */
  import(json) {
    const parsed = JSON.parse(json);
    const data = migrate(parsed);
    if (!data || !data.steps || !data.exercises?.length) {
      throw new Error('データ形式が不正です');
    }
    this.save(data);
    return data;
  },

  clear() {
    localStorage.removeItem(KEY);
  },
};
