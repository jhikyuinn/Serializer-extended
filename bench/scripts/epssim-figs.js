// §74 ε 시뮬레이션 요약 + 그림. 입력: Serializer/kafka/processor/epssim-grid.out
//   node epssim-figs.js [입력] [출력 폴더]
// 경로 비용은 시뮬레이션과 같게 10 ms + 0.02 ms × 배치. 따라갈 수 있는 최대 TPS(capacity) = 배치 / (경로 비용 + 정렬 시간)
const fs = require('fs'), path = require('path');
const IN = process.argv[2] || path.join(__dirname, '../../kafka/processor/epssim-grid.out');
const OUT = process.argv[3] || path.join(__dirname, '../../experiments/02-epsilon-realtime/figures');
fs.mkdirSync(OUT, { recursive: true });
const g = (l, k) => { const m = l.match(new RegExp(`\\b${k}=([^ ]+)`)); return m ? m[1] : undefined; };
const lines = fs.readFileSync(IN, 'utf8').split('\n');
const EPS = [['0.00', '0.00', '0'], ['0.25', '0.25', '0.25'], ['0.50', '0.50', '0.5'], ['0.10', '0.75', '0.1/0.75'], ['0.75', '0.75', '0.75'], ['1.00', '1.00', '1']];
const key = (u, s, b, e) => `${u}|${s}|${b}|${e[0]}|${e[1]}`;
const B = {}, T = {};
for (const l of lines) {
  if (!l.startsWith('[EPSSIM')) continue;
  const u = String(g(l, 'urgent')) === 'true' || g(l, 'urgent') === '1', s = (+g(l, 's')).toFixed(1), b = +g(l, 'batch');
  const e = [(+g(l, 'epsU')).toFixed(2), (+g(l, 'epsL')).toFixed(2)];
  const k = key(u, s, b, e);
  if (l.startsWith('[EPSSIM-BATCH]')) {
    if (/TIMEOUT/.test(l)) { B[k] = { timeout: true }; continue; }
    const ovh = 10 + 0.02 * b, sm = +g(l, 'sort_mean'), sx = +g(l, 'sort_max');
    B[k] = { sm, sp90: +g(l, 'sort_p90'), sx, valid: +g(l, 'valid'), fab: +g(l, 'fabric_valid'), urg: +g(l, 'urgent_ok'), jain: +g(l, 'jain'),
      cap: b * 1000 / (ovh + sm), capW: b * 1000 / (ovh + sx) };
  } else {
    (T[k] ??= []).push({ tps: +g(l, 'tps'), om: +g(l, 'ord_mean'), ox: +g(l, 'ord_max'), olast: +g(l, 'ord_last'), miss: +g(l, 'miss'), tot: +g(l, 'total_mean') });
  }
}
fs.writeFileSync(path.join(OUT, 'epssim-data.json'), JSON.stringify({ B, T }, null, 1));

// ---- 표 ----
const f = (x, d = 1) => (x === undefined || Number.isNaN(x)) ? '-' : x.toFixed(d);
for (const u of [false, true]) for (const b of [5000, 10000]) {
  console.log(`\n### 긴급 ${u ? '켬' : '끔'}, 배치 ${b} — 정렬 ms 평균[최대] · 따라갈 수 있는 TPS 평균/최악 · 살린 비율 · 긴급 생존 · Jain`);
  console.log('| ε | s 1.0 | s 1.5 | s 2.0 |\n|---|---|---|---|');
  for (const e of EPS) {
    const cells = ['1.0', '1.5', '2.0'].map((s) => {
      const r = B[key(u, s, b, e)]; if (!r) return '-'; if (r.timeout) return '>900 s';
      return `${f(r.sm)}[${f(r.sx, 0)}] · ${f(r.cap / 1000, 1)}k/${f(r.capW / 1000, 1)}k · ${f(100 * r.valid)}%${u ? ` · 긴급 ${f(100 * r.urg)}%` : ''} · J ${f(r.jain, 3)}`;
    });
    console.log(`| ${e[2]} | ${cells.join(' | ')} |`);
  }
}
console.log('\n### 정렬 지연(배치가 다 찬 뒤 처리 끝까지) 평균 ms / 마감 1 s 위반 비율 — 긴급 끔, 배치 10000');
console.log('| s | ε | 1k | 2k | 5k | 10k | 20k TPS |\n|---|---|---|---|---|---|---|');
for (const s of ['1.0', '1.5', '2.0']) for (const e of EPS) {
  const t = T[key(false, s, 10000, e)]; if (!t) continue;
  console.log(`| ${s} | ${e[2]} | ${t.map((x) => `${f(x.om, 0)}${x.miss > 0 ? ` (${f(100 * x.miss, 0)}%)` : ''}`).join(' | ')} |`);
}

// ---- 그림 ----
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const Tx = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
const SC = { '1.0': '#2563eb', '1.5': '#d97706', '2.0': '#dc2626' };
const xsE = (x0, w) => (i) => x0 + (i + 0.5) * w / EPS.length;
function logAxis(x0, y0, w, h, lo, hi, ticks, ylabel, title) {
  const ym = (v) => y0 - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * h; let s = '';
  for (const t of ticks) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + Tx(x0 - 6, ym(t) + 4, t >= 1000 ? `${t / 1000}k` : t, 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  s += Tx(x0 - 48, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 48} ${y0 - h / 2})"`);
  s += Tx(x0 + w / 2, y0 - h - 10, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  const xs = xsE(x0, w); EPS.forEach((e, i) => { s += Tx(xs(i), y0 + 16, e[2], 'text-anchor="middle"'); });
  s += Tx(x0 + w / 2, y0 + 33, 'ε (긴급·일반 같은 값. 0.1/0.75 = 긴급 0.1·일반 0.75)', 'text-anchor="middle" fill="#444" font-size="11"');
  return { s, ym, xs };
}
const legendS = (x, y) => ['1.0', '1.5', '2.0'].map((s, i) => `<line x1="${x + i * 90}" y1="${y - 4}" x2="${x + i * 90 + 18}" y2="${y - 4}" stroke="${SC[s]}" stroke-width="2.5"/><circle cx="${x + i * 90 + 9}" cy="${y - 4}" r="3.5" fill="${SC[s]}"/>` + Tx(x + i * 90 + 22, y, `s ${s}`)).join('');
// 그림 E1: 비용 — 정렬 시간과 따라갈 수 있는 TPS (긴급 끔, 배치 10000)
{
  const W = 1000, H = 440, b = 10000; let body = '';
  const A = logAxis(90, 350, 360, 270, 0.1, 10000, [0.1, 1, 10, 100, 1000, 10000], '배치당 정렬 시간 (ms, 로그)', '(a) 비용: 배치당 정렬 시간 (평균, 막대 = 최대)');
  body += A.s;
  for (const s of ['1.0', '1.5', '2.0']) {
    const pts = EPS.map((e, i) => [A.xs(i), B[key(false, s, b, e)]]).filter(([, r]) => r && !r.timeout);
    body += `<polyline points="${pts.map(([x, r]) => `${x},${A.ym(r.sm)}`).join(' ')}" fill="none" stroke="${SC[s]}" stroke-width="2.3"/>`;
    for (const [x, r] of pts) body += `<circle cx="${x}" cy="${A.ym(r.sm)}" r="4" fill="${SC[s]}"/><line x1="${x}" y1="${A.ym(r.sm)}" x2="${x}" y2="${A.ym(r.sx)}" stroke="${SC[s]}" stroke-dasharray="2 2"/><path d="M${x - 4} ${A.ym(r.sx)} h8" stroke="${SC[s]}"/>`;
  }
  body += `<line x1="90" y1="${A.ym(1000)}" x2="450" y2="${A.ym(1000)}" stroke="#111" stroke-dasharray="5 3"/>` + Tx(445, A.ym(1000) - 5, '1 s', 'text-anchor="end" font-size="11"');
  const C = logAxis(600, 350, 360, 270, 1000, 1e7, [1000, 10000, 100000, 1e6, 1e7], '따라갈 수 있는 최대 TPS (로그)', '(b) 실시간 처리 한도: 배치 / (경로 비용 + 정렬)');
  body += C.s;
  for (const s of ['1.0', '1.5', '2.0']) {
    const pts = EPS.map((e, i) => [C.xs(i), B[key(false, s, b, e)]]).filter(([, r]) => r && !r.timeout);
    body += `<polyline points="${pts.map(([x, r]) => `${x},${C.ym(r.cap)}`).join(' ')}" fill="none" stroke="${SC[s]}" stroke-width="2.3"/>`;
    body += `<polyline points="${pts.map(([x, r]) => `${x},${C.ym(r.capW)}`).join(' ')}" fill="none" stroke="${SC[s]}" stroke-width="1.3" stroke-dasharray="4 3"/>`;
    for (const [x, r] of pts) body += `<circle cx="${x}" cy="${C.ym(r.cap)}" r="4" fill="${SC[s]}"/>`;
  }
  for (const t of [4000, 20000]) body += `<line x1="600" y1="${C.ym(t)}" x2="960" y2="${C.ym(t)}" stroke="#111" stroke-dasharray="5 3" stroke-opacity="0.6"/>` + Tx(955, C.ym(t) - 4, t === 4000 ? '4k (이번 클라우드 한계)' : '20k', 'text-anchor="end" font-size="10.5"');
  body += legendS(330, 30) + Tx(600, 30, '실선 = 평균 정렬 기준, 점선 = 최악 배치 기준', 'font-size="11" fill="#444"');
  body += Tx(W / 2, H - 12, `배치 ${b}, 긴급 끔, smallbank 합성(계좌 100, 쓰기 50%), 경로 비용 10 ms + 0.02 ms/tx (클라우드 실측 기반), 조건마다 배치 12개 실제 정렬`, 'text-anchor="middle" fill="#555" font-size="11"');
  fs.writeFileSync(path.join(OUT, 'figE1-cost.svg'), svg(W, H, body));
}
// 그림 E2: 이득 — 살린 비율, 긴급 생존, 공정성 (배치 10000)
{
  const W = 1000, H = 400, b = 10000; let body = '';
  const lin = (x0, y0, w, h, lo, hi, ticks, yl, title, fmt) => {
    const ym = (v) => y0 - (v - lo) / (hi - lo) * h; let s = '';
    for (const t of ticks) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + Tx(x0 - 6, ym(t) + 4, fmt(t), 'text-anchor="end" font-size="11"');
    s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
    s += Tx(x0 - 44, y0 - h / 2, yl, `text-anchor="middle" transform="rotate(-90 ${x0 - 44} ${y0 - h / 2})"`);
    s += Tx(x0 + w / 2, y0 - h - 10, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
    const xs = xsE(x0, w); EPS.forEach((e, i) => { s += Tx(xs(i), y0 + 16, e[2], 'text-anchor="middle" font-size="11"'); });
    return { s, ym, xs };
  };
  const panels = [
    ['valid', false, 0.4, 0.6, [0.4, 0.45, 0.5, 0.55, 0.6], '배치 안 살린 비율', '(a) 살린 tx 비율 (긴급 끔)', (v) => `${(v * 100).toFixed(0)}%`],
    ['urg', true, 0, 1, [0, 0.25, 0.5, 0.75, 1], '긴급 tx 생존율', '(b) 긴급 tx 생존율 (긴급 켬)', (v) => `${(v * 100).toFixed(0)}%`],
    ['jain', false, 0.9, 1, [0.9, 0.925, 0.95, 0.975, 1], 'Jain 지수', '(c) 사용자별 쓰기 성공률의 공정성 (긴급 끔)', (v) => v.toFixed(3)],
  ];
  panels.forEach(([k, u, lo, hi, ticks, yl, title, fmt], j) => {
    const P = lin(80 + j * 320, 320, 240, 230, lo, hi, ticks, yl, title, fmt); body += P.s;
    for (const s of ['1.0', '1.5', '2.0']) {
      const pts = EPS.map((e, i) => [P.xs(i), B[key(u, s, b, e)]]).filter(([, r]) => r && !r.timeout && !Number.isNaN(r[k]));
      body += `<polyline points="${pts.map(([x, r]) => `${x},${P.ym(r[k])}`).join(' ')}" fill="none" stroke="${SC[s]}" stroke-width="2.3"/>`;
      for (const [x, r] of pts) body += `<circle cx="${x}" cy="${P.ym(r[k])}" r="3.8" fill="${SC[s]}"/>`;
    }
  });
  body += legendS(380, 30);
  body += Tx(W / 2, H - 12, `배치 ${b}, smallbank 합성(계좌 100, 쓰기 50%, 사용자 5명, 긴급 = User3 의 쓰기). 가로축 ε. 배치 안 결과(배치 사이의 낡은 읽기는 보지 않는다)`, 'text-anchor="middle" fill="#555" font-size="11"');
  fs.writeFileSync(path.join(OUT, 'figE2-benefit.svg'), svg(W, H, body));
}
// 그림 E3: 시간 흐름 — TPS 별 정렬 지연 (긴급 끔, 배치 10000, s 2.0)
{
  const W = 700, H = 420, b = 10000, s = '2.0'; let body = '';
  const TPS = [1000, 2000, 5000, 10000, 20000], x0 = 90, y0 = 340, w = 520, h = 270;
  const xm = (t) => x0 + (Math.log10(t) - 3) / (Math.log10(20000) - 3) * w, lo = 10, hi = 100000;
  const ym = (v) => y0 - (Math.log10(Math.max(v, lo)) - 1) / (Math.log10(hi) - 1) * h;
  for (const t of [10, 100, 1000, 10000, 100000]) body += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + Tx(x0 - 6, ym(t) + 4, t >= 1000 ? `${t / 1000} s` : `${t} ms`, 'text-anchor="end" font-size="11"');
  body += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  for (const t of TPS) body += Tx(xm(t), y0 + 16, t >= 1000 ? `${t / 1000}k` : t, 'text-anchor="middle"');
  body += Tx(x0 + w / 2, y0 + 34, '도착 TPS (로그)', 'text-anchor="middle" fill="#444"');
  body += Tx(x0 - 50, y0 - h / 2, '정렬 지연 평균 (로그)', `text-anchor="middle" transform="rotate(-90 ${x0 - 50} ${y0 - h / 2})"`);
  body += Tx(x0 + w / 2, y0 - h - 12, `정렬 지연: 배치가 다 찬 뒤 정렬 결과가 나오기까지 (배치 ${b}, s ${s}, 긴급 끔)`, 'text-anchor="middle" font-weight="bold" font-size="13"');
  body += `<line x1="${x0}" y1="${ym(1000)}" x2="${x0 + w}" y2="${ym(1000)}" stroke="#111" stroke-dasharray="5 3"/>` + Tx(x0 + w - 4, ym(1000) - 5, '마감 1 s', 'text-anchor="end" font-size="11"');
  const EC = ['#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#d97706', '#dc2626'];
  EPS.forEach((e, i) => {
    const t = T[key(false, s, b, e)]; if (!t) return;
    body += `<polyline points="${t.map((x) => `${xm(x.tps)},${ym(x.om)}`).join(' ')}" fill="none" stroke="${EC[i]}" stroke-width="2.3"/>`;
    for (const x of t) body += `<circle cx="${xm(x.tps)}" cy="${ym(x.om)}" r="3.8" fill="${EC[i]}"/>`;
    body += `<line x1="${x0 + 10 + i * 85}" y1="34" x2="${x0 + 28 + i * 85}" y2="34" stroke="${EC[i]}" stroke-width="2.5"/>` + Tx(x0 + 32 + i * 85, 38, `ε ${e[2]}`);
  });
  body += Tx(W / 2, H - 12, `배치 ${b}개(12배치)를 실제로 정렬한 시간으로 계산. 경로 비용 10 ms + 0.02 ms/tx. 정렬이 배치 도착을 못 따라가면 지연이 쌓인다`, 'text-anchor="middle" fill="#555" font-size="10.5"');
  fs.writeFileSync(path.join(OUT, 'figE3-timeline.svg'), svg(W, H, body));
}
