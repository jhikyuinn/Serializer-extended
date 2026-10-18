// §56 그림: (A) s 1.0 고정 배치 효과, (B) Fabric 실패율 대비 이득·지연 곡선. §54(계좌 100, 3회) + §55(저충돌, 1회분)
//   node cloudfigs.js [출력 폴더]   → fig-a-batch.svg, fig-b-contention.svg, fig-data.json
const fs = require('fs'), path = require('path');
// CLOUD_DIR·CLOUD_PREFIX 로 다른 묶음을 쓸 수 있다(§78 재측정: results/cloud2, cloud2)
const R = process.env.CLOUD_DIR || path.join(__dirname, '../../../bench/zipfbench/results/cloud');
const PFX = process.env.CLOUD_PREFIX || 'cloud';
const OUT = process.argv[2] || path.join(__dirname, '../figures');
fs.mkdirSync(OUT, { recursive: true });
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));

// 한 조건·시스템의 반복마다 정상 구간(tallySteady) 값
function runs(dir) {
  const out = [];
  for (const rep of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const d = path.join(dir, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
    const a = {};
    for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) {
      for (const [k, x] of Object.entries(JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady.all)) a[k] = (a[k] || 0) + x;
    }
    if (!a.total) continue;
    out.push({ sp: a.success / dur, fail: 100 * (1 - a.success / a.total), lat: a.latencySuccessSum / a.success, all: (a.latencySuccessSum + a.latencyFailSum) / a.total });
  }
  return out;
}
const stat = (rs, k) => [m(rs.map((r) => r[k])), sd(rs.map((r) => r[k]))];
function cond(name, extra) {
  const F = runs(path.join(R, name, 'A1', 'u0')), S = runs(path.join(R, name, 'BE', 'u0'));
  if (!F.length || !S.length) return null;
  const n = Math.min(F.length, S.length);
  return { ...extra, n, F: { sp: stat(F, 'sp'), fail: stat(F, 'fail'), lat: stat(F, 'lat'), all: stat(F, 'all') },
    S: { sp: stat(S, 'sp'), fail: stat(S, 'fail'), lat: stat(S, 'lat'), all: stat(S, 'all') } };
}
const SS = ['0', '0.5', '1.0', '1.5', '2.0'], BS = [100, 500, 1000];
const pts = [];
for (const b of BS) for (const s of SS) { const c = cond(`${PFX}-s${s}-b${b}`, { acct: 100, s, b }); if (c) pts.push(c); }
for (const a of [1000, 10000]) for (const b of BS) for (const s of SS) { const c = cond(`${PFX}-a${a}-s${s}-b${b}`, { acct: a, s, b }); if (c) pts.push(c); }
for (const p of pts) { p.ratio = p.S.sp[0] / p.F.sp[0]; p.dLat = p.S.lat[0] - p.F.lat[0]; p.dAll = p.S.all[0] - p.F.all[0]; }
fs.writeFileSync(path.join(OUT, 'fig-data.json'), JSON.stringify(pts, null, 1));

// ---- SVG 도우미 ----
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const C = { F: '#8a8f98', S: '#2563eb', 100: '#2563eb', 500: '#d97706', 1000: '#dc2626' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
function axes(x0, y0, w, h, yticks, ymap, ylabel, title) {
  let s = `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  for (const t of yticks) { const y = ymap(t); s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="#e5e7eb"/>` + T(x0 - 6, y + 4, t.label ?? t, 'text-anchor="end"'); }
  s += T(x0 - 46, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 46} ${y0 - h / 2})"`);
  s += T(x0 + w / 2, y0 - h - 14, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  return s;
}
const errbar = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#111"/><line x1="${x - 4}" y1="${y1}" x2="${x + 4}" y2="${y1}" stroke="#111"/><line x1="${x - 4}" y1="${y2}" x2="${x + 4}" y2="${y2}" stroke="#111"/>`;
const legend = (x, y, items) => items.map(([lab, col, kind], i) => {
  const yy = y + i * 18;
  const mark = kind === 'hollow' ? `<circle cx="${x + 7}" cy="${yy - 4}" r="4.5" fill="#fff" stroke="#555" stroke-width="1.5"/>`
    : kind === 'dot' ? `<circle cx="${x + 7}" cy="${yy - 4}" r="4.5" fill="#555"/>`
    : kind === 'diamond' ? `<path d="M${x + 7} ${yy - 10} l5 6 l-5 6 l-5 -6z" fill="#fff" stroke="#111" stroke-width="1.3"/>`
    : kind === 'line' ? `<line x1="${x}" y1="${yy - 4}" x2="${x + 16}" y2="${yy - 4}" stroke="${col}" stroke-width="2.5"/><circle cx="${x + 8}" cy="${yy - 4}" r="3.5" fill="${col}"/>`
    : `<rect x="${x}" y="${yy - 10}" width="14" height="12" fill="${col}"/>`;
  return mark + T(x + 20, yy, lab);
}).join('');

// ---- 그림 A: s 1.0 고정, 배치 100/500/1000 ----
{
  const A = BS.map((b) => pts.find((p) => p.acct === 100 && p.s === '1.0' && p.b === b));
  const W = 960, H = 480, y0 = 390, h = 280, pw = 330;
  let body = '';
  // (a) 성공 처리량
  {
    const x0 = 90, ymax = 600, ym = (v) => y0 - (v / ymax) * h;
    body += axes(x0, y0, pw, h, [0, 100, 200, 300, 400, 500, 600], ym, '성공 tx / s', '(a) 성공 처리량');
    A.forEach((p, i) => {
      const cx = x0 + 55 + i * 110, bw = 32;
      [['F', cx - bw - 2], ['S', cx + 2]].forEach(([k, x]) => {
        const v = p[k].sp;
        body += `<rect x="${x}" y="${ym(v[0])}" width="${bw}" height="${y0 - ym(v[0])}" fill="${C[k]}"/>` + errbar(x + bw / 2, ym(v[0] + v[1]), ym(v[0] - v[1]));
      });
      body += T(cx + 2 + bw / 2, ym(p.S.sp[0] + p.S.sp[1]) - 8, `×${p.ratio.toFixed(2)}`, 'text-anchor="middle" font-weight="bold"');
      body += T(cx, y0 + 18, `배치 ${p.b}`, 'text-anchor="middle"');
      body += T(cx, y0 + 34, `Fabric 실패 ${p.F.fail[0].toFixed(0)}%`, 'text-anchor="middle" fill="#666" font-size="11"');
    });
  }
  // (b) 지연
  {
    const x0 = 560, ymax = 1800, ym = (v) => y0 - (v / ymax) * h;
    body += axes(x0, y0, pw, h, [0, 300, 600, 900, 1200, 1500, 1800], ym, '지연 (ms)', '(b) 성공 tx 커밋 지연 / 모든 tx 결과까지 지연');
    A.forEach((p, i) => {
      const cx = x0 + 55 + i * 110, bw = 32;
      [['F', cx - bw - 2], ['S', cx + 2]].forEach(([k, x]) => {
        const v = p[k].lat, a = p[k].all[0], dx = x + bw / 2;
        body += `<rect x="${x}" y="${ym(v[0])}" width="${bw}" height="${y0 - ym(v[0])}" fill="${C[k]}"/>` + errbar(dx, ym(v[0] + v[1]), ym(v[0] - v[1]));
        body += `<path d="M${dx} ${ym(a) - 6} l5 6 l-5 6 l-5 -6z" fill="#fff" stroke="#111" stroke-width="1.3"/>`;
      });
      body += T(cx + 2 + bw / 2, ym(p.S.lat[0] + p.S.lat[1]) - 8, `${p.dLat >= 0 ? '+' : ''}${p.dLat.toFixed(0)} ms`, 'text-anchor="middle" font-weight="bold"');
      body += T(cx, y0 + 18, `배치 ${p.b}`, 'text-anchor="middle"');
      body += T(cx, y0 + 34, `모든 tx ${p.dAll >= 0 ? '+' : ''}${p.dAll.toFixed(0)} ms`, 'text-anchor="middle" fill="#666" font-size="11"');
    });
  }
  body += legend(200, 30, [['Fabric (같은 소스, A1)', C.F]]) + legend(400, 30, [['Serializer (일반 ε 0.75, 긴급 0)', C.S]]) + legend(600, 30, [['모든 tx 결과까지 지연', '', 'diamond']]);
  body += T(W / 2, H - 14, 'smallbank, 계좌 100, Zipf s = 1.0, 1,000 TPS, Query 50%, 사용자 5명, 긴급 0 · AWS 4 VM · 30초(앞 5초 제외) × 3회 평균 ± 표준편차', 'text-anchor="middle" fill="#555" font-size="11"');
  fs.writeFileSync(path.join(OUT, 'fig-a-batch.svg'), svg(W, H, body));
}

// ---- 그림 B: 가로축 Fabric 실패율 ----
{
  const W = 980, H = 470, y0 = 370, h = 290, pw = 360;
  const xm = (x0) => (f) => x0 + (f / 100) * pw;
  let body = '';
  const series = (x0, ym, key) => {
    let s = '';
    for (const b of BS) {
      const main = pts.filter((p) => p.acct === 100 && p.b === b).sort((u, v) => u.F.fail[0] - v.F.fail[0]);
      const low = pts.filter((p) => p.acct !== 100 && p.b === b);
      const all = [...low, ...main].sort((u, v) => u.F.fail[0] - v.F.fail[0]);
      const X = xm(x0);
      if (all.length > 1) s += `<polyline points="${all.map((p) => `${X(p.F.fail[0]).toFixed(1)},${ym(p[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${C[b]}" stroke-width="${key === 'dLat' ? 1.2 : 2}" stroke-opacity="${key === 'dLat' ? 0.45 : 0.8}"/>`;
      for (const p of low) s += `<circle cx="${X(p.F.fail[0])}" cy="${ym(p[key])}" r="4.5" fill="#fff" stroke="${C[b]}" stroke-width="1.8"/>`;
      for (const p of main) {
        if (key === 'dLat') { const e = Math.hypot(p.F.lat[1], p.S.lat[1]), x = X(p.F.fail[0]); s += `<line x1="${x}" y1="${ym(p.dLat + e)}" x2="${x}" y2="${ym(p.dLat - e)}" stroke="${C[b]}" stroke-width="1.2"/>`; }
        s += `<circle cx="${X(p.F.fail[0])}" cy="${ym(p[key])}" r="4.5" fill="${C[b]}"/>`;
        if (p.s === '1.0') s += `<circle cx="${X(p.F.fail[0])}" cy="${ym(p[key])}" r="8.5" fill="none" stroke="#111" stroke-width="1.3"/>`;
        if (['0', '1.0', '2.0'].includes(p.s)) s += T(X(p.F.fail[0]) - 7, ym(p[key]) - 8, `s${p.s}`, `text-anchor="end" font-size="10" fill="${C[b]}"`);
      }
    }
    return s;
  };
  const xaxis = (x0) => { let s = ''; for (const f of [0, 20, 40, 60, 80, 100]) s += T(xm(x0)(f), y0 + 16, `${f}%`, 'text-anchor="middle"'); return s + T(x0 + pw / 2, y0 + 36, '기준 Fabric 실패율 (혼잡도)', 'text-anchor="middle"'); };
  // (a) 배율, 로그 축
  {
    const x0 = 90, lo = Math.log(0.8), hi = Math.log(8), ym = (v) => y0 - ((Math.log(v) - lo) / (hi - lo)) * h;
    body += axes(x0, y0, pw, h, [1, 1.5, 2, 3, 4, 6, 8], ym, '성공 처리량 배율 (Serializer / Fabric, 로그 축)', '(a) 처리량 이득');
    body += `<line x1="${x0}" y1="${ym(1)}" x2="${x0 + pw}" y2="${ym(1)}" stroke="#111" stroke-dasharray="4 3"/>`;
    body += xaxis(x0) + series(x0, ym, 'ratio');
  }
  // (b) 커밋 지연 차이
  {
    const x0 = 580, lo = -50, hi = 550, ym = (v) => y0 - ((v - lo) / (hi - lo)) * h;
    body += axes(x0, y0, pw, h, [0, 100, 200, 300, 400, 500], ym, '성공 tx 커밋 지연 차이 (S − F, ms)', '(b) 지연 비용 (막대: 3회 합성 표준편차)');
    body += `<line x1="${x0}" y1="${ym(0)}" x2="${x0 + pw}" y2="${ym(0)}" stroke="#111" stroke-dasharray="4 3"/>`;
    body += xaxis(x0) + series(x0, ym, 'dLat');
  }
  body += legend(110, 96, [['배치 100', C[100], 'line'], ['배치 500', C[500], 'line'], ['배치 1000', C[1000], 'line']]);
  body += legend(110, 156, [['계좌 100, s 0~2 (3회)', '', 'dot'], ['계좌 1천·1만, s 0~1 (1회분)', '', 'hollow']]);
  body += `<circle cx="117" cy="188" r="8.5" fill="none" stroke="#111" stroke-width="1.3"/>` + T(130, 192, '주 실험 지점 (s 1.0)');
  body += T(W / 2, H - 14, 'smallbank, 1,000 TPS, Query 50%, 사용자 5명, 긴급 0 · AWS 4 VM · 30초(앞 5초 제외) · 점 옆 숫자는 Zipf s (계좌 100)', 'text-anchor="middle" fill="#555" font-size="11"');
  fs.writeFileSync(path.join(OUT, 'fig-b-contention.svg'), svg(W, H, body));
}

// 표로도 찍는다
console.log('| 계좌 | s | 배치 | 회 | Fabric 실패율 | F 성공/s | S 성공/s | 배율 | 커밋 지연 F → S (ms) | 차이 | 모든 tx 차이 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of [...pts].sort((u, v) => u.b - v.b || u.F.fail[0] - v.F.fail[0]))
  console.log(`| ${p.acct} | ${p.s} | ${p.b} | ${p.n} | ${p.F.fail[0].toFixed(1)}% | ${p.F.sp[0].toFixed(1)} | ${p.S.sp[0].toFixed(1)} | ${p.ratio.toFixed(2)}× | ${p.F.lat[0].toFixed(0)} → ${p.S.lat[0].toFixed(0)} | ${p.dLat >= 0 ? '+' : ''}${p.dLat.toFixed(0)} | ${p.dAll >= 0 ? '+' : ''}${p.dAll.toFixed(0)} |`);
