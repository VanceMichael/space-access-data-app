// 时间全部换算为「相对当日 18:00 的分钟数」，负号表示 18:00 之前。
// 约定：时间窗半开 [from, to)，办理 minutes 为完整用时，须在 to（不含）前办结。
export const ANCHOR = '18:00';
export const ANCHOR_MINUTES = 18 * 60;

export function toMinutes(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute - ANCHOR_MINUTES;
}

export function formatMinutes(value) {
  const total = ANCHOR_MINUTES + value;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 行程耗时按出发时刻选用：严格早于 18:00 用 before_18 列，否则用 from_18 列。
// 兼容 loader 的驼峰字段与原始 CSV 列名两种结构。
export function travelAt(journey, departAt) {
  const before18 = journey.minutes_before_18 ?? journey.before18;
  const from18 = journey.minutes_from_18 ?? journey.from18;
  return departAt < 0 ? Number(before18) : Number(from18);
}
