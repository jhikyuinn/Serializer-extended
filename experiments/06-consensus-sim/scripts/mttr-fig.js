// §87 MTTR 재측정 그림: mttr run.log → figures/fig-mttr.svg
//   node mttr-fig.js <mttr run.log> <출력 svg>
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').map((l) => l.match(/ new (\w+) #\d+ .*takeover=(\d+)ms mttr=(\d+)ms applied=10\/10/)).filter(Boolean)
  .map((m) => ({ type: m[1], tk: +m[2] / 1000, mttr: +m[3] / 1000 }));
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${t}</text>`;
const TYPES = [['term', '정상 종료 (pod 삭제)'], ['kill', '강제 종료 (SIGKILL)'], ['stop', '멈춤 (SIGSTOP)']];
const W = 760, H = 430, x0 = 120, y0 = 350, w = 600, h = 290, MAX = 8, ym = (v) => y0 - v / MAX * h;
const med = (a) => { const s = [...a].sort((p, q) => p - q); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
let b = '';
for (let t = 0; t <= MAX; t++) b += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, `${t} s`, 'text-anchor="end" font-size="11"');
b += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
b += T(x0 - 50, y0 - h / 2, '시간 (장애 발생부터)', `text-anchor="middle" transform="rotate(-90 ${x0 - 50} ${y0 - h / 2})"`);
TYPES.forEach(([k, label], i) => {
  const cx = x0 + (i + 0.5) * w / 3, r = rows.filter((x) => x.type === k);
  for (const [key, dx, col] of [['tk', -45, '#2563eb'], ['mttr', 45, '#dc2626']]) {
    const v = r.map((x) => x[key]), m = med(v);
    b += `<rect x="${cx + dx - 28}" y="${ym(m)}" width="56" height="${y0 - ym(m)}" fill="${col}" fill-opacity="0.18"/>`;
    b += `<line x1="${cx + dx}" y1="${ym(Math.min(...v))}" x2="${cx + dx}" y2="${ym(Math.max(...v))}" stroke="${col}"/>`;
    v.forEach((y, j) => b += `<circle cx="${cx + dx + (j - (v.length - 1) / 2) * 4}" cy="${ym(y)}" r="3" fill="${col}" fill-opacity="0.75"/>`);
    b += `<line x1="${cx + dx - 28}" y1="${ym(m)}" x2="${cx + dx + 28}" y2="${ym(m)}" stroke="${col}" stroke-width="2.5"/>` + T(cx + dx + (dx < 0 ? -32 : 32), ym(m) + 4, `${m.toFixed(2)} s`, `text-anchor="${dx < 0 ? 'end' : 'start'}" font-size="11.5" font-weight="bold" fill="${col}"`);
  }
  b += T(cx, y0 + 18, label, 'text-anchor="middle"') + T(cx, y0 + 34, `${r.length}회`, 'text-anchor="middle" font-size="11" fill="#666"');
});
b += T(W / 2, 26, 's-node 장애 복구 시간 재측정 (2026-10-19, s-node 3 pod, w-node 10개)', 'text-anchor="middle" font-weight="bold" font-size="14"');
b += `<rect x="200" y="40" width="14" height="10" fill="#2563eb" fill-opacity="0.5"/>` + T(219, 49, '활성 전환 (Lease 인계)', 'font-size="12"');
b += `<rect x="390" y="40" width="14" height="10" fill="#dc2626" fill-opacity="0.5"/>` + T(409, 49, 'MTTR (w-node 10개 모두 새 커미티 적용)', 'font-size="12"');
b += T(W / 2, H - 22, '막대 높이·굵은 선 = 중앙값, 점 = 시행별 값, 세로선 = 최소~최대. MTTR은 w-node 재등록까지 포함한 실측이다.', 'text-anchor="middle" font-size="11" fill="#555"');
fs.writeFileSync(process.argv[3], `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} font-size="12">\n<rect width="${W}" height="${H}" fill="#fff"/>\n${b}\n</svg>\n`);
