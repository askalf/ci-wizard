// Small numeric and time helpers shared by collect, analyse and the reports.

/** Seconds from ISO time a to ISO time b, never negative (GitHub stamps whole seconds). */
export function secs(a, b) {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
}

/** The arithmetic mean; 0 for an empty list. A total is a mean times a count, never a median times one. */
export function mean(v) {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

export function median(v) {
  if (!v.length) return 0;
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The q-th quantile by the nearest-rank-below rule: index floor(q * n), clamped to the last. */
export function pct(v, q) {
  if (!v.length) return 0;
  const s = [...v].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function round(x, digits = 0) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** "42 s" under two minutes, "3.5 min" from there. */
export function fmtS(x) {
  return x < 120 ? `${Math.round(x)} s` : `${(x / 60).toFixed(1)} min`;
}

export function sum(v) {
  return v.reduce((a, b) => a + b, 0);
}

export function countBy(items, key) {
  const out = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
