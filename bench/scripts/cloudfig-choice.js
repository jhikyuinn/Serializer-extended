// §64 주 실험 조건 s = 1.0 을 고른 이유를 한 그림에 (배치 100, 계좌 100, §54 3회)
//   위: 성공 처리량(이득), 가운데: 지연 비용, 아래: 기준 Fabric 의 상태(실패율). 같은 s 축.
//   cloudfigs.js 가 만든 fig-data.json 을 읽는다.   node cloudfig-choice.js [출력 폴더]
const fs = require('fs'), path = require('path');
const OUT = process.argv[2] || path.join(__dirname, '../../experiments/cloud-figs');
const pts = JSON.parse(fs.readFileSync(path.join(OUT, 'fig-data.json'))).filter((p) => p.acct === 100 && p.b === 100)
  .sort((a, b) => +a.s - +b.s);
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const C = { F: '#8a8f98', S: '#2563eb', bad: '#dc2626' };
const W = 860, H = 760, x0 = 110, pw = 560;
const X = (s) => x0 + 40 + (s / 2) * (pw - 80);
const errbar = (x, y1, y2, col) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}"/><line x1="${x - 3}" y1="${y1}" x2="${x + 3}" y2="${y1}" stroke="${col}"/><line x1="${x - 3}" y1="${y2}" x2="${x + 3}" y2="${y2}" stroke="${col}"/>`;
let body = '';

// 행 공통 틀
function row(y0, h, lo, hi, ticks, ylabel, title, fmt = (v) => v) {
  const ym = (v) => y0 - ((v - lo) / (hi - lo)) * h; let s = '';
  for (const t of ticks) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + pw}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, fmt(t), 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + pw}" y2="${y0}" stroke="#333"/>`;
  s += T(x0 - 52, y0 - h / 2, ylabel, `text-anchor="middle" font-size="11.5" transform="rotate(-90 ${x0 - 52} ${y0 - h / 2})"`);
  s += T(x0 + 4, y0 - h - 8, title, 'font-weight="bold" font-size="13"');
  return { s, ym };
}
const rows = [[250, 150], [455, 130], [650, 130]];
// 강조 띠 (s 1.0) 와 YCSB 표시: 세 행 전체에 걸친다
const top = rows[0][0] - rows[0][1], bot = rows[2][0];
body += `<rect x="${X(1) - 34}" y="${top - 4}" width="68" height="${bot - top + 4}" fill="#fef3c7"/>`;
body += `<rect x="${X(1.5) - 34}" y="${top - 4}" width="${X(2) - X(1.5) + 68}" height="${bot - top + 4}" fill="#fee2e2" opacity="0.6"/>`;
body += `<line x1="${X(0.99)}" y1="${top - 4}" x2="${X(0.99)}" y2="${bot}" stroke="#92400e" stroke-dasharray="5 3"/>`;

// (1) 성공 처리량
{
  const R = row(...rows[0], 0, 700, [0, 100, 200, 300, 400, 500, 600, 700], '초당 성공 tx', '① 이득: 초당 성공 tx');
  body += R.s;
  for (const [k, col] of [['F', C.F], ['S', C.S]]) {
    body += `<polyline points="${pts.map((p) => `${X(+p.s)},${R.ym(p[k].sp[0])}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2.4"/>`;
    for (const p of pts) body += `<circle cx="${X(+p.s)}" cy="${R.ym(p[k].sp[0])}" r="4" fill="${col}"/>` + errbar(X(+p.s), R.ym(p[k].sp[0] + p[k].sp[1]), R.ym(p[k].sp[0] - p[k].sp[1]), col);
  }
  for (const p of pts) body += T(X(+p.s), R.ym(p.S.sp[0]) - 11, `×${p.ratio.toFixed(2)}`, `text-anchor="middle" font-size="11" font-weight="bold" fill="${C.S}"`);
  body += `<line x1="${x0 + pw - 190}" y1="${rows[0][0] - rows[0][1] + 14}" x2="${x0 + pw - 172}" y2="${rows[0][0] - rows[0][1] + 14}" stroke="${C.F}" stroke-width="2.5"/>` + T(x0 + pw - 166, rows[0][0] - rows[0][1] + 18, 'Fabric (같은 소스)', 'font-size="11"');
  body += `<line x1="${x0 + pw - 190}" y1="${rows[0][0] - rows[0][1] + 32}" x2="${x0 + pw - 172}" y2="${rows[0][0] - rows[0][1] + 32}" stroke="${C.S}" stroke-width="2.5"/>` + T(x0 + pw - 166, rows[0][0] - rows[0][1] + 36, 'Serializer', 'font-size="11"');
}
// (2) 지연 비용
{
  const R = row(...rows[1], -20, 60, [-20, 0, 20, 40, 60], '지연 차이 S − F (ms)', '② 비용: 지연 차이 (막대 = 성공 tx 커밋 지연, ◇ = 모든 tx 결과까지)');
  body += R.s + `<line x1="${x0}" y1="${R.ym(0)}" x2="${x0 + pw}" y2="${R.ym(0)}" stroke="#111"/>`;
  for (const p of pts) {
    const x = X(+p.s), e = Math.hypot(p.F.lat[1], p.S.lat[1]);
    body += `<rect x="${x - 13}" y="${Math.min(R.ym(p.dLat), R.ym(0))}" width="26" height="${Math.abs(R.ym(p.dLat) - R.ym(0))}" fill="#93c5fd"/>` + errbar(x, R.ym(p.dLat + e), R.ym(p.dLat - e), '#1e3a8a');
    body += `<path d="M${x} ${R.ym(p.dAll) - 6} l5 6 l-5 6 l-5 -6z" fill="#fff" stroke="#111" stroke-width="1.3"/>`;
    body += T(x + 17, R.ym(p.dLat) + 4, `+${p.dLat.toFixed(0)}`, 'font-size="10.5" fill="#1e3a8a"');
  }
}
// (3) 기준 Fabric 의 상태
{
  const R = row(...rows[2], 0, 100, [0, 25, 50, 75, 100], 'Fabric 실패율 (%)', '③ 기준 시스템의 상태: Fabric 실패율 (= 혼잡도)', (v) => v);
  body += R.s;
  body += `<polyline points="${pts.map((p) => `${X(+p.s)},${R.ym(p.F.fail[0])}`).join(' ')}" fill="none" stroke="${C.bad}" stroke-width="2.4"/>`;
  for (const p of pts) body += `<circle cx="${X(+p.s)}" cy="${R.ym(p.F.fail[0])}" r="4" fill="${C.bad}"/>` + T(X(+p.s) + 8, R.ym(p.F.fail[0]) + 15, `${p.F.fail[0].toFixed(0)}%`, `font-size="10.5" fill="${C.bad}"`);
  for (const p of pts) body += T(X(+p.s), rows[2][0] + 16, p.s, 'text-anchor="middle"');
  body += T(x0 + pw / 2, rows[2][0] + 34, 'Zipf s (계좌 100, 배치 100)', 'text-anchor="middle" fill="#444"');
}
// 띠 설명
body += T(X(1), top - 12, '주 실험 조건 s 1.0', `text-anchor="middle" font-weight="bold" font-size="12" fill="#92400e"`);
body += T(X(0.99) - 4, bot - 6, 'YCSB 기본 0.99', 'text-anchor="end" font-size="10.5" fill="#92400e"');
body += T((X(1.5) + X(2)) / 2, top - 12, '극단 혼잡: 기준이 무너짐', `text-anchor="middle" font-weight="bold" font-size="12" fill="${C.bad}"`);

// 오른쪽 설명 칸
const p1 = pts.find((p) => p.s === '1.0'), p2 = pts.find((p) => p.s === '2.0'), p0 = pts.find((p) => p.s === '0');
const notes = [
  ['s 1.0을 고른 기준', '#111', true],
  ['결과를 보기 전에 정할 수 있고(YCSB 0.99),', '#333'],
  ['기준 시스템이 아직 동작하는 범위에서', '#333'],
  ['지연 비용이 작고 이득이 뚜렷한 지점.', '#333'],
  ['', ''],
  [`① 이득 ×${p1.ratio.toFixed(2)}`, C.S, true],
  [`   s 0~0.5의 ×${p0.ratio.toFixed(2)}보다 뚜렷하다`, '#333'],
  [`② 지연 +${p1.dLat.toFixed(0)} ms (모든 tx +${p1.dAll.toFixed(0)})`, '#1e3a8a', true],
  ['   배치 100은 s와 상관없이 +5~42 ms로 작다', '#333'],
  ['   → 지연은 s를 가르는 기준이 되지 못한다', '#333'],
  [`③ Fabric 실패 ${p1.F.fail[0].toFixed(0)}%`, C.bad, true],
  [`   성공 ${p1.F.sp[0].toFixed(0)}/s로 아직 동작한다`, '#333'],
  ['', ''],
  ['s 1.5~2.0은 왜 아닌가', '#111', true],
  [`이득은 ×${p2.ratio.toFixed(2)}로 크지만`, '#333'],
  [`Fabric 실패 ${pts.find((p) => p.s === '1.5').F.fail[0].toFixed(0)}~${p2.F.fail[0].toFixed(0)}%, 성공 ${p2.F.sp[0].toFixed(0)}/s.`, '#333'],
  ['무너진 기준과 비교한 이득이라', '#333'],
  ['대표값으로 쓰면 과장이 된다.', '#333'],
  ['(그래도 곡선의 끝점으로는 보인다)', '#666'],
];
notes.forEach(([t, col, b], i) => { body += T(x0 + pw + 22, 120 + i * 21, t, `font-size="12" fill="${col}"${b ? ' font-weight="bold"' : ''}`); });

body = T(W / 2, 36, '주 실험 조건 s = 1.0을 고른 이유 (배치 100)', 'text-anchor="middle" font-weight="bold" font-size="16"') + body;
body += T(W / 2, H - 14, 'smallbank, 1,000 TPS, Query 50%, 사용자 5명, 긴급 0 · AWS 4 VM · 30초(앞 5초 제외) × 3회 평균 ± 표준편차', 'text-anchor="middle" fill="#555" font-size="11"');
fs.writeFileSync(path.join(OUT, 'fig7-why-s1.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 230}" height="${H}" viewBox="0 0 ${W + 230} ${H}" ${FONT} font-size="12">\n<rect width="${W + 230}" height="${H}" fill="#fff"/>\n${body}\n</svg>\n`);
