/**
 * Tính hình của biểu đồ cho ô hỏi linh vật (03/11/2026): khối `chart` → danh sách hình (chữ nhật, nét, chấm, chữ) theo toạ độ; cửa sổ chỉ vẽ lại đúng danh sách đó
 * (askChartSource.mjs). Tính ở daemon để PowerShell không phải chạy vòng lặp toán, và test được không cần cửa sổ. Đủ 12 kiểu như `ChartComponent.txt`.
 * Hình: `{ k: 'r', x, y, w, h, f, rx? }`, `{ k: 'p', d, s?, f?, sw?, dash? }`, `{ k: 'c', x, y, r, f, s? }`, `{ k: 't', x, y, w, t, a?, c?, z?, b? }`.
 */
const WIDTH = 288;
const CHART_HEIGHT = 150;
const ROUND_HEIGHT = 150;
const RADAR_HEIGHT = 180;
/** Nền cột nhạt, nét đường đậm cùng tông: giống bảng màu biểu đồ trên web. */
const FILLS = ['#93C5FD', '#6EE7B7', '#FCD34D', '#FCA5A5', '#C4B5FD', '#67E8F9'];
const INKS = ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2'];
const POSITIVE = '#34D399';
const NEGATIVE = '#F87171';
const POSITIVE_INK = '#059669';
const NEGATIVE_INK = '#DC2626';
const GRID = '#EEF0F4';
const TICK_INK = '#86909C';
const TEXT_INK = '#4E5969';
const TICK_SIZE = 10.5;
const CHAR_PX = 5.6;
/** Chữ số rộng hơn chữ thường một chút: nhãn trục mà tính thiếu thì bị cắt mất số. */
const TICK_CHAR_PX = 6.4;
const LABEL_GAP = 4;

const BAR_KINDS = new Set(['bar', 'stackedBar']);
const HORIZONTAL_KINDS = new Set(['horizontalBar', 'stackedHorizontalBar']);
const STACKED_KINDS = new Set(['stackedBar', 'stackedHorizontalBar']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fix = (v) => Math.round(v * 100) / 100;
const point = (x, y) => `${fix(x)} ${fix(y)}`;

function formatter(lang) {
  try {
    return new Intl.NumberFormat(lang || 'en', { notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  }
}

/** Mốc trục tròn số bao trọn [min, max]. */
export function niceTicks(min, max, count = 4) {
  if (min === max) { max = min === 0 ? 1 : min + Math.abs(min) / 2; min = min > 0 ? 0 : min - (min < 0 ? Math.abs(min) / 2 : 0); }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = low; v <= high + step / 2; v += step) ticks.push(fix(v * 1e6) / 1e6);
  return { min: low, max: high, ticks };
}

const text = (x, y, w, t, extra = {}) => ({ k: 't', x: fix(x), y: fix(y), w: fix(w), t, ...extra });
const hline = (x1, x2, y, s = GRID) => ({ k: 'p', d: `M${point(x1, y)}L${point(x2, y)}`, s, sw: 1 });
const vline = (x, y1, y2, s = GRID) => ({ k: 'p', d: `M${point(x, y1)}L${point(x, y2)}`, s, sw: 1 });

const seriesFill = (s, i) => s.color || (s.semantic === 'positive' ? POSITIVE : s.semantic === 'negative' ? NEGATIVE : FILLS[i % FILLS.length]);
const seriesInk = (s, i) => s.color || (s.semantic === 'positive' ? POSITIVE_INK : s.semantic === 'negative' ? NEGATIVE_INK : INKS[i % INKS.length]);

/** Một dãy duy nhất có cả số dương lẫn âm: tăng xanh, giảm đỏ, như web. */
const mixedSigns = (series) => series.length === 1 && series[0].data.some((v) => num(v) > 0) && series[0].data.some((v) => num(v) < 0);

function barColor(series, seriesIndex, value, pointIndex, all) {
  const s = series;
  if (mixedSigns(all) && !s.color) return value < 0 ? NEGATIVE : POSITIVE;
  // Nhấn vài cột: cột thường nhạt đi, cột nhấn dùng màu đậm.
  if (s.highlight?.length) return s.highlight.includes(pointIndex) ? seriesInk(s, seriesIndex) : seriesFill(s, seriesIndex);
  return seriesFill(s, seriesIndex);
}

function stackedRange(series, n) {
  let low = 0;
  let high = 0;
  for (let p = 0; p < n; p++) {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = num(s.data[p]) ?? 0;
      if (v >= 0) up += v; else down += v;
    }
    high = Math.max(high, up);
    low = Math.min(low, down);
  }
  return [low, high];
}

function plainRange(series, includeZero) {
  const values = series.flatMap((s) => s.data.map(num)).filter((v) => v !== null);
  if (!values.length) return null;
  return [includeZero ? Math.min(0, ...values) : Math.min(...values), includeZero ? Math.max(0, ...values) : Math.max(...values)];
}

/** Nhãn danh mục dọc trục ngang: nhãn dày thì cách quãng để không đè nhau. */
function categoryLabels(shapes, labels, n, left, slot, y) {
  const every = Math.max(1, Math.ceil((CHAR_PX * 6) / slot));
  for (let i = 0; i < n; i += every) {
    if (!labels[i]) continue;
    const w = slot * every - 2;
    shapes.push(text(left + slot * i + slot / 2 - w / 2, y, w, labels[i], { a: 'c', c: TICK_INK, z: TICK_SIZE }));
  }
}

function pointCount(chart) {
  return Math.max(chart.labels.length, ...chart.series.map((s) => s.data.length));
}

/** Cột dọc gom nhóm / chồng + đường, gồm cả `combo` (đường theo trục phải). */
function verticalChart(chart, lang) {
  const { series, labels, kind } = chart;
  const n = pointCount(chart);
  const fmt = formatter(lang);
  const isLine = (s) => kind === 'line' || (kind === 'combo' && s.type === 'line');
  const leftSeries = series.filter((s) => s.axis !== 'right');
  const rightSeries = series.filter((s) => s.axis === 'right');
  const stacked = STACKED_KINDS.has(kind);
  const includeZero = kind !== 'line';
  const leftRange = stacked ? stackedRange(leftSeries, n) : plainRange(leftSeries, includeZero);
  if (!leftRange) return null;
  const left = niceTicks(leftRange[0], leftRange[1]);
  const rightRange = rightSeries.length ? plainRange(rightSeries, false) : null;
  const right = rightRange ? niceTicks(rightRange[0], rightRange[1]) : null;
  const tickWidth = (ticks) => Math.max(...ticks.map((v) => fmt.format(v).length)) * TICK_CHAR_PX + LABEL_GAP;
  const x0 = tickWidth(left.ticks);
  const x1 = WIDTH - (right ? tickWidth(right.ticks) + LABEL_GAP : 4);
  const y0 = 6;
  const y1 = CHART_HEIGHT - 20;
  const yOf = (scale, v) => y1 - ((v - scale.min) / (scale.max - scale.min || 1)) * (y1 - y0);
  const shapes = [];
  for (const v of left.ticks) {
    const y = yOf(left, v);
    shapes.push(hline(x0, x1, y, v === 0 ? '#C9CDD4' : GRID));
    shapes.push(text(0, y - 7, x0 - LABEL_GAP, fmt.format(v), { a: 'r', c: TICK_INK, z: TICK_SIZE }));
  }
  if (right) {
    for (const v of right.ticks) shapes.push(text(x1 + LABEL_GAP, yOf(right, v) - 7, WIDTH - x1 - LABEL_GAP, fmt.format(v), { a: 'l', c: TICK_INK, z: TICK_SIZE }));
  }
  const slot = (x1 - x0) / Math.max(n, 1);
  const barSeries = series.filter((s) => !isLine(s));
  const groupWidth = slot * 0.72;
  const barWidth = stacked ? Math.min(groupWidth, 32) : Math.min(groupWidth / Math.max(barSeries.length, 1), 24);
  for (let p = 0; p < n; p++) {
    let up = 0;
    let down = 0;
    let at = 0;
    const groupStart = x0 + slot * p + slot / 2 - (stacked ? barWidth : barWidth * barSeries.length) / 2;
    series.forEach((s, si) => {
      if (isLine(s)) return;
      const v = num(s.data[p]);
      const index = at++;
      if (v === null) return;
      const scale = s.axis === 'right' && right ? right : left;
      let from = 0;
      if (stacked) { from = v >= 0 ? up : down; if (v >= 0) up += v; else down += v; }
      const a = yOf(scale, from);
      const b = yOf(scale, from + v);
      shapes.push({
        k: 'r', x: fix(stacked ? groupStart : groupStart + index * barWidth + 0.5), y: fix(Math.min(a, b)), w: fix(Math.max(1, barWidth - (stacked ? 0 : 1))), h: fix(Math.max(1, Math.abs(a - b))),
        f: barColor(s, si, v, p, series), rx: stacked ? 0 : 2,
      });
    });
  }
  series.forEach((s, si) => {
    if (!isLine(s)) return;
    const scale = s.axis === 'right' && right ? right : left;
    const ink = seriesInk(s, si);
    let d = '';
    let pen = false;
    for (let p = 0; p < n; p++) {
      const v = num(s.data[p]);
      if (v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${point(x0 + slot * p + slot / 2, yOf(scale, v))}`;
      pen = true;
    }
    if (d) shapes.push({ k: 'p', d, s: ink, sw: 2 });
    if (n <= 16) {
      for (let p = 0; p < n; p++) {
        const v = num(s.data[p]);
        if (v !== null) shapes.push({ k: 'c', x: fix(x0 + slot * p + slot / 2), y: fix(yOf(scale, v)), r: 2.5, f: '#FFFFFF', s: ink });
      }
    }
  });
  categoryLabels(shapes, labels, n, x0, slot, y1 + 4);
  return { w: WIDTH, h: CHART_HEIGHT, shapes };
}

function horizontalChart(chart, lang) {
  const { series, labels, kind } = chart;
  const n = pointCount(chart);
  const fmt = formatter(lang);
  const stacked = STACKED_KINDS.has(kind);
  const range = stacked ? stackedRange(series, n) : plainRange(series, true);
  if (!range) return null;
  const scale = niceTicks(range[0], range[1], 3);
  const labelWidth = Math.min(96, Math.max(24, Math.max(0, ...labels.map((l) => (l || '').length)) * CHAR_PX + LABEL_GAP));
  const x0 = labelWidth + LABEL_GAP;
  const x1 = WIDTH - 8;
  const groupHeight = stacked ? 16 : Math.max(10, Math.min(8 * series.length + 4, 24));
  const rowHeight = groupHeight + 6;
  const h = n * rowHeight + 20;
  const xOf = (v) => x0 + ((v - scale.min) / (scale.max - scale.min || 1)) * (x1 - x0);
  const shapes = [];
  for (const v of scale.ticks) {
    const x = xOf(v);
    shapes.push(vline(x, 2, h - 18, v === 0 ? '#C9CDD4' : GRID));
    shapes.push(text(x - 24, h - 15, 48, fmt.format(v), { a: 'c', c: TICK_INK, z: TICK_SIZE }));
  }
  for (let p = 0; p < n; p++) {
    const top = 3 + p * rowHeight;
    if (labels[p]) shapes.push(text(0, top + groupHeight / 2 - 7, labelWidth, labels[p], { a: 'r', c: TEXT_INK, z: TICK_SIZE }));
    let up = 0;
    let down = 0;
    series.forEach((s, si) => {
      const v = num(s.data[p]);
      if (v === null) return;
      let from = 0;
      if (stacked) { from = v >= 0 ? up : down; if (v >= 0) up += v; else down += v; }
      const a = xOf(from);
      const b = xOf(from + v);
      const barHeight = stacked ? groupHeight : groupHeight / series.length;
      shapes.push({
        k: 'r', x: fix(Math.min(a, b)), y: fix(stacked ? top : top + si * barHeight), w: fix(Math.max(1, Math.abs(a - b))), h: fix(Math.max(1, barHeight - (stacked ? 0 : 1))),
        f: barColor(s, si, v, p, series), rx: stacked ? 0 : 2,
      });
    });
  }
  return { w: WIDTH, h, shapes };
}

function sector(cx, cy, r, inner, start, end) {
  const sweep = end - start;
  // Một lát trọn vòng: vẽ hai nửa, cung trùng điểm đầu cuối thì không ra hình.
  if (sweep >= Math.PI * 2 - 1e-4) return `${sector(cx, cy, r, inner, start, start + Math.PI)}${sector(cx, cy, r, inner, start + Math.PI, start + Math.PI * 2)}`;
  const at = (radius, angle) => point(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  const large = sweep > Math.PI ? 1 : 0;
  if (!inner) return `M${point(cx, cy)}L${at(r, start)}A${fix(r)} ${fix(r)} 0 ${large} 1 ${at(r, end)}Z`;
  return `M${at(r, start)}A${fix(r)} ${fix(r)} 0 ${large} 1 ${at(r, end)}L${at(inner, end)}A${fix(inner)} ${fix(inner)} 0 ${large} 0 ${at(inner, start)}Z`;
}

function pieChart(chart) {
  const values = chart.series[0].data.map((v) => Math.max(0, num(v) ?? 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const cy = ROUND_HEIGHT / 2;
  const cx = WIDTH / 2;
  const r = cy - 4;
  const inner = chart.kind === 'doughnut' ? r * 0.58 : 0;
  const shapes = [];
  const legend = [];
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const color = chart.series[0].highlight?.includes(i) ? INKS[i % INKS.length] : FILLS[i % FILLS.length];
    const pct = Math.round((v / total) * 100);
    if (chart.labels[i]) legend.push({ label: `${chart.labels[i]} ${pct}%`, color });
    if (!v) return;
    const end = angle + (v / total) * Math.PI * 2;
    shapes.push({ k: 'p', d: sector(cx, cy, r, inner, angle, end), f: color, s: '#FFFFFF', sw: 1.5 });
    if (pct >= 8) {
      const mid = (angle + end) / 2;
      const rr = inner ? (r + inner) / 2 : r * 0.62;
      shapes.push(text(cx + rr * Math.cos(mid) - 18, cy + rr * Math.sin(mid) - 7, 36, `${pct}%`, { a: 'c', c: TEXT_INK, z: TICK_SIZE, b: true }));
    }
    angle = end;
  });
  return { w: WIDTH, h: ROUND_HEIGHT, shapes, legend };
}

function polarChart(chart) {
  const values = chart.series[0].data.map((v) => Math.max(0, num(v) ?? 0));
  const max = Math.max(...values);
  if (!max) return null;
  const cy = ROUND_HEIGHT / 2;
  const cx = WIDTH / 2;
  const r = cy - 4;
  const shapes = [];
  const legend = [];
  for (const k of [1, 0.66, 0.33]) shapes.push({ k: 'c', x: cx, y: cy, r: fix(r * k), f: null, s: GRID });
  const slice = (Math.PI * 2) / values.length;
  values.forEach((v, i) => {
    const start = -Math.PI / 2 + i * slice;
    const color = FILLS[i % FILLS.length];
    if (chart.labels[i]) legend.push({ label: chart.labels[i], color });
    if (v) shapes.push({ k: 'p', d: sector(cx, cy, r * (v / max), 0, start, start + slice), f: `#CC${color.slice(1)}`, s: '#FFFFFF', sw: 1 });
  });
  return { w: WIDTH, h: ROUND_HEIGHT, shapes, legend };
}

function radarChart(chart) {
  const n = pointCount(chart);
  const range = plainRange(chart.series, true);
  if (!range || n < 3) return null;
  const scale = niceTicks(0, Math.max(range[1], 1), 4);
  const cx = WIDTH / 2;
  const cy = RADAR_HEIGHT / 2;
  const r = cy - 20;
  const at = (i, k) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)];
  };
  const shapes = [];
  for (const v of scale.ticks.slice(1)) {
    const k = v / scale.max;
    shapes.push({ k: 'p', d: `${Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${point(...at(i, k))}`).join('')}Z`, s: GRID, sw: 1 });
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = at(i, 1);
    shapes.push({ k: 'p', d: `M${point(cx, cy)}L${point(x, y)}`, s: GRID, sw: 1 });
    if (chart.labels[i]) {
      const [lx, ly] = at(i, 1.1);
      const onLeft = lx < cx - 4;
      const onRight = lx > cx + 4;
      const w = 76;
      shapes.push(text(onLeft ? lx - w : onRight ? lx : lx - w / 2, ly - 7, w, chart.labels[i], { a: onLeft ? 'r' : onRight ? 'l' : 'c', c: TICK_INK, z: TICK_SIZE }));
    }
  }
  chart.series.forEach((s, si) => {
    const ink = seriesInk(s, si);
    const pts = Array.from({ length: n }, (_, i) => at(i, Math.max(0, num(s.data[i]) ?? 0) / scale.max));
    shapes.push({ k: 'p', d: `${pts.map((p, i) => `${i ? 'L' : 'M'}${point(...p)}`).join('')}Z`, s: ink, sw: 1.6, f: `#33${ink.slice(1)}` });
    for (const p of pts) shapes.push({ k: 'c', x: fix(p[0]), y: fix(p[1]), r: 2, f: ink });
  });
  return { w: WIDTH, h: RADAR_HEIGHT, shapes };
}

function scatterChart(chart, lang) {
  const pts = chart.series.flatMap((s) => s.data).filter((v) => v && typeof v === 'object');
  if (!pts.length) return null;
  const fmt = formatter(lang);
  const xs = niceTicks(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)));
  const ys = niceTicks(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)));
  const x0 = Math.max(...ys.ticks.map((v) => fmt.format(v).length)) * TICK_CHAR_PX + LABEL_GAP;
  const x1 = WIDTH - 8;
  const y0 = 6;
  const y1 = CHART_HEIGHT - 20;
  const px = (v) => x0 + ((v - xs.min) / (xs.max - xs.min || 1)) * (x1 - x0);
  const py = (v) => y1 - ((v - ys.min) / (ys.max - ys.min || 1)) * (y1 - y0);
  const shapes = [];
  for (const v of ys.ticks) {
    shapes.push(hline(x0, x1, py(v)));
    shapes.push(text(0, py(v) - 7, x0 - LABEL_GAP, fmt.format(v), { a: 'r', c: TICK_INK, z: TICK_SIZE }));
  }
  for (const v of xs.ticks) {
    shapes.push(vline(px(v), y0, y1));
    shapes.push(text(px(v) - 22, y1 + 4, 44, fmt.format(v), { a: 'c', c: TICK_INK, z: TICK_SIZE }));
  }
  const maxR = Math.max(1, ...pts.map((p) => num(p.r) ?? 0));
  chart.series.forEach((s, si) => {
    const ink = seriesInk(s, si);
    for (const p of s.data) {
      if (!p || typeof p !== 'object') continue;
      const r = chart.kind === 'bubble' ? Math.max(3, Math.sqrt((num(p.r) ?? 0) / maxR) * 14) : 3;
      shapes.push({ k: 'c', x: fix(px(p.x)), y: fix(py(p.y)), r: fix(r), f: `#66${ink.slice(1)}`, s: ink });
    }
  });
  return { w: WIDTH, h: CHART_HEIGHT, shapes };
}

function seriesLegend(chart) {
  if (chart.series.length < 2 && !chart.series[0]?.label) return [];
  return chart.series.filter((s) => s.label).map((s) => {
    const si = chart.series.indexOf(s);
    const line = chart.kind === 'line' || chart.kind === 'radar' || chart.kind === 'scatter' || chart.kind === 'bubble' || (chart.kind === 'combo' && s.type === 'line');
    return { label: s.label, color: line ? seriesInk(s, si) : seriesFill(s, si) };
  });
}

/** Khối biểu đồ → `{ w, h, shapes, legend }`; không có số để vẽ → null (nơi gọi đổi thành nhãn + nút xem trên web). */
export function chartLayout(chart, lang) {
  if (!chart?.series?.length) return null;
  const { kind } = chart;
  let out = null;
  if (kind === 'pie' || kind === 'doughnut') out = pieChart(chart);
  else if (kind === 'polarArea') out = polarChart(chart);
  else if (kind === 'radar') out = radarChart(chart);
  else if (kind === 'scatter' || kind === 'bubble') out = scatterChart(chart, lang);
  else if (HORIZONTAL_KINDS.has(kind)) out = horizontalChart(chart, lang);
  else if (BAR_KINDS.has(kind) || kind === 'line' || kind === 'combo') out = verticalChart(chart, lang);
  if (!out) return null;
  return { ...out, legend: out.legend || seriesLegend(chart) };
}
