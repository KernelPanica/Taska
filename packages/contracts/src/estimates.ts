/**
 * Шкалы оценки и конвертер (R-2.26; YT-04, docs/adr/0010).
 *
 * Каждая шкала приводится к дням через конвертер пространства:
 * - порядковая шкала (майки XS–XL и свои): у каждого значения — диапазон дней, «S ≈ 1–2 дня»;
 * - числовая шкала (очки и свои): сколько дней в одной единице, тоже диапазоном;
 * - системная шкала «Дни» — сама в днях, в конвертере не нуждается.
 * Основной шкалы нет: смотрящий выбирает, в какой считать; остальные приводятся конвертером.
 * Функции общие для сервера и интерфейса, чтобы ориентир и свёртка считались одинаково.
 */

export const SCALE_KINDS = ["ordinal", "numeric"] as const;
export type ScaleKind = (typeof SCALE_KINDS)[number];

/** Системные шкалы, которые создаёт миграция. */
export const TSHIRT_SCALE_KEY = "tshirt";
export const DAYS_SCALE_KEY = "days";

export interface ScaleValue {
  id: string;
  label: string;
}

export interface EstimateScale {
  id: string;
  key: string;
  name: string;
  kind: ScaleKind;
  /** Единица числовой шкалы («дн.», «очк.»); у порядковой — null. */
  unit: string | null;
  /** Значения порядковой шкалы по возрастанию; у числовой — пусто. */
  values: ScaleValue[];
  system: boolean;
}

export interface EstimateScaleInput {
  name: string;
  key?: string;
  kind: ScaleKind;
  unit?: string | null;
  values?: string[];
}

/** Строка конвертера: значение порядковой шкалы (или одна единица числовой, valueId = null) ≈ дни. */
export interface ConverterEntry {
  scaleId: string;
  valueId: string | null;
  minDays: number;
  maxDays: number;
}

export interface Converter {
  /** null — конвертер по умолчанию для всех пространств. */
  spaceId: string | null;
  /** true — у пространства нет своего конвертера, действует конвертер по умолчанию. */
  inherited: boolean;
  entries: ConverterEntry[];
}

/** Оценка тикета: шкала и значение (id значения порядковой шкалы или число). */
export interface Estimate {
  scaleId: string;
  value: string | number;
}

export interface DayRange {
  min: number;
  max: number;
}

/** Результат в выбранной шкале: диапазон в её единицах и, для порядковой, ближайшее значение. */
export interface ScaledRange {
  scaleId: string;
  min: number;
  max: number;
  valueId: string | null;
  /** Оценка была в этой шкале и не приводилась конвертером. */
  exact: boolean;
}

const isDays = (scale: EstimateScale) => scale.key === DAYS_SCALE_KEY;

function entry(converter: Converter, scaleId: string, valueId: string | null) {
  return converter.entries.find((item) => item.scaleId === scaleId && item.valueId === valueId);
}

/** Ориентир в днях для одной оценки; null — в конвертере нет строки для этого значения. */
export function toDays(scale: EstimateScale, value: string | number, converter: Converter): DayRange | null {
  if (scale.kind === "numeric") {
    const amount = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(amount)) return null;
    if (isDays(scale)) return { min: amount, max: amount };
    const perUnit = entry(converter, scale.id, null);
    return perUnit ? { min: amount * perUnit.minDays, max: amount * perUnit.maxDays } : null;
  }
  const row = entry(converter, scale.id, String(value));
  return row ? { min: row.minDays, max: row.maxDays } : null;
}

/** Переводит диапазон дней в шкалу. Для порядковой — значение, чей диапазон ближе всего к середине. */
export function fromDays(scale: EstimateScale, days: DayRange, converter: Converter): ScaledRange | null {
  if (scale.kind === "numeric") {
    if (isDays(scale)) return { scaleId: scale.id, min: days.min, max: days.max, valueId: null, exact: false };
    const perUnit = entry(converter, scale.id, null);
    if (!perUnit || perUnit.minDays <= 0 || perUnit.maxDays <= 0) return null;
    return {
      scaleId: scale.id,
      min: days.min / perUnit.maxDays,
      max: days.max / perUnit.minDays,
      valueId: null,
      exact: false,
    };
  }
  const middle = (days.min + days.max) / 2;
  let best: { valueId: string; distance: number } | null = null;
  for (const value of scale.values) {
    const row = entry(converter, scale.id, value.id);
    if (!row) continue;
    const distance = middle < row.minDays ? row.minDays - middle : middle > row.maxDays ? middle - row.maxDays : 0;
    if (!best || distance < best.distance) best = { valueId: value.id, distance };
  }
  return best ? { scaleId: scale.id, min: days.min, max: days.max, valueId: best.valueId, exact: false } : null;
}

/**
 * Оценка тикета в выбранной шкале: если у тикета есть оценка в этой шкале — берём её как есть,
 * иначе приводим первую оценку, для которой в конвертере есть строка.
 */
export function estimateIn(
  estimates: readonly Estimate[],
  target: EstimateScale,
  scales: readonly EstimateScale[],
  converter: Converter,
): ScaledRange | null {
  const own = estimates.find((item) => item.scaleId === target.id);
  if (own) {
    if (target.kind === "numeric") {
      const amount = Number(own.value);
      if (Number.isFinite(amount)) return { scaleId: target.id, min: amount, max: amount, valueId: null, exact: true };
    } else {
      const days = toDays(target, own.value, converter);
      return {
        scaleId: target.id,
        min: days?.min ?? 0,
        max: days?.max ?? 0,
        valueId: String(own.value),
        exact: true,
      };
    }
  }
  for (const item of estimates) {
    const scale = scales.find((candidate) => candidate.id === item.scaleId);
    const days = scale ? toDays(scale, item.value, converter) : null;
    if (days) return fromDays(target, days, converter);
  }
  return null;
}

/**
 * Свёртка оценок детей в выбранной шкале (R-2.12, R-2.26). Каждый ребёнок учитывается один раз.
 * Числовая шкала суммируется в своих единицах; порядковая — в днях, итог приводится к ближайшему значению.
 */
export function rollupEstimates(
  children: readonly (readonly Estimate[])[],
  target: EstimateScale,
  scales: readonly EstimateScale[],
  converter: Converter,
): { result: ScaledRange | null; counted: number; skipped: number } {
  let min = 0;
  let max = 0;
  let counted = 0;
  let skipped = 0;
  let exact = true;
  for (const estimates of children) {
    const value = estimateIn(estimates, target, scales, converter);
    if (!value) {
      skipped += estimates.length ? 1 : 0;
      continue;
    }
    counted += 1;
    exact &&= value.exact;
    // Числовая шкала: value — в её единицах; порядковая: value.min/max — ориентир в днях
    // (порядковые значения не складываются).
    min += value.min;
    max += value.max;
  }
  if (counted === 0) return { result: null, counted, skipped };
  if (target.kind === "numeric") {
    return { result: { scaleId: target.id, min, max, valueId: null, exact }, counted, skipped };
  }
  const result = fromDays(target, { min, max }, converter);
  return { result: result && { ...result, exact: exact && counted === 1 }, counted, skipped };
}
