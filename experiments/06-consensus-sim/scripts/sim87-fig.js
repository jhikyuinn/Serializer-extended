// §87 합의 성공률 그림: data/simulation-1019.json → figures/fig-consensus.svg
//   node sim87-fig.js <simulation json> <출력 svg>
const fs = require('fs');
const D = JSON.parse(fs.readFileSync(process.argv[2])), OUT = process.argv[3];
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const PC = { 1: '#16a34a', 5: '#2563eb', 10: '#d97706', 15: '#dc2626' };
const [oldC, newC] = D.configs;
const W = 1060, H = 470; let b = '';
function panel(x0, title, lo, key) {
  const y0 = 370, w = 400, h = 270, ym = (v) => y0 - (v - lo) / (100 - lo) * h, xs = (n) => x0 + (n - 0.5) * w / 5;
  let s = '';
  for (let t = lo; t <= 100; t += 10) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, `${t}%`, 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  for (let n = 1; n <= 5; n++) s += T(xs(n), y0 + 16, n, 'text-anchor="middle"');
  s += T(x0 + w / 2, y0 + 34, 's-node pod 수 (replica)', 'text-anchor="middle" fill="#444"');
  s += T(x0 - 48, y0 - h / 2, '합의 성공률 (500라운드, 마감 10 s)', `text-anchor="middle" font-size="11.5" transform="rotate(-90 ${x0 - 48} ${y0 - h / 2})"`);
  s += T(x0 + w / 2, y0 - h - 12, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  for (const p of [1, 5, 10, 15]) {
    for (const [cfg, dash] of [[newC, false], [oldC, true]]) {
      if (dash && p !== 15) continue; // 예전 설계는 15% 만 비교로 그린다
      const pts = cfg[key].filter((x) => x.failProb === p).map((x) => [xs(x.replicas), ym(x.mean), ym(x.p95), ym(x.p5)]);
      s += `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${PC[p]}" stroke-width="${dash ? 1.6 : 2.4}"${dash ? ' stroke-dasharray="5 3"' : ''}/>`;
      for (const [x, y, hi, lo2] of pts) s += dash ? `<circle cx="${x}" cy="${y}" r="3.2" fill="#fff" stroke="${PC[p]}" stroke-width="1.5"/>` : `<line x1="${x}" y1="${hi}" x2="${x}" y2="${lo2}" stroke="${PC[p]}" stroke-opacity="0.5"/><circle cx="${x}" cy="${y}" r="3.8" fill="${PC[p]}"/>`;
    }
  }
  return s;
}
b += panel(90, '(a) Byzantine w-node 3/10 포함', 40, 'withByzantine');
b += panel(610, '(b) pod 장애만 (Byzantine 없음)', 70, 'withoutByzantine');
b += [1, 5, 10, 15].map((p, i) => `<line x1="${250 + i * 120}" y1="36" x2="${270 + i * 120}" y2="36" stroke="${PC[p]}" stroke-width="2.5"/>` + T(275 + i * 120, 40, `pod 장애 ${p}%`)).join('');
b += `<line x1="730" y1="36" x2="750" y2="36" stroke="#dc2626" stroke-width="1.6" stroke-dasharray="5 3"/>` + T(755, 40, '예전 설계(15%)');
b += T(W / 2, H - 30, `시뮬레이션(설정마다 ${D.runs}회 × 500라운드, 막대 = 5~95%). 지금 설계: Lease 인계 실측(SIGSTOP 10회, 중앙 2.44 s) + 유예 3 s + 커미티 0.35 s, w-node 재접속 1~2 s.`, 'text-anchor="middle" fill="#555" font-size="11"');
b += T(W / 2, H - 12, '라운드 10 s 간격, 비잔틴 리더: 서명 위조(5 s 뒤 실패) / 30 s 지연(정체 확인 10 s × 2). w-node 10개. 예전 설계: Lease 6 s, 커미티 3.2 s, 재접속 8~15 s(2026-10-13 보정)', 'text-anchor="middle" fill="#555" font-size="11"');
fs.writeFileSync(OUT, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} font-size="12">\n<rect width="${W}" height="${H}" fill="#fff"/>\n${b}\n</svg>\n`);
