// 실험 1~3(NOTES §86) 그림: data/exp3.json, data/exp21.md → figures/fig-exp{1,2,3}.svg
//   node exp-figs.js <data 폴더> <figures 폴더>
const fs = require('fs'), path = require('path');
const D = process.argv[2], F = process.argv[3];
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${t}</text>`;
const SYS = [['A1', 'Fabric', '#6b7280'], ['FPP', 'Fabric++', '#d97706'], ['HTF', 'HTFabric', '#7c3aed'], ['BE075', 'Serializer', '#2563eb']];
const svg = (W, H, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} font-size="12">\n<rect width="${W}" height="${H}" fill="#fff"/>\n${b}\n</svg>\n`;
// 막대 패널: groups = [{label, vals:[{v, col, stack?}]}]
function bars(x0, y0, w, h, max, step, unit, title, groups, fmt = (v) => v.toFixed(0)) {
  let s = '';
  const ym = (v) => y0 - v / max * h;
  for (let t = 0; t <= max + 1e-9; t += step) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, `${+t.toFixed(2)}${unit}`, 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>` + T(x0 + w / 2, y0 - h - 12, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  const gw = w / groups.length;
  groups.forEach((g, i) => {
    const n = g.vals.length, bw = Math.min(34, (gw - 20) / n);
    g.vals.forEach((x, j) => {
      const bx = x0 + i * gw + gw / 2 + (j - n / 2) * bw;
      s += `<rect x="${bx + 2}" y="${ym(x.v)}" width="${bw - 4}" height="${y0 - ym(x.v)}" fill="${x.col}" fill-opacity="0.85"/>`;
      if (x.part) s += `<rect x="${bx + 2}" y="${ym(x.part)}" width="${bw - 4}" height="${y0 - ym(x.part)}" fill="#fff" fill-opacity="0.45"/>`;
      s += T(bx + bw / 2, ym(x.v) - 4, fmt(x.v), 'text-anchor="middle" font-size="10.5"');
    });
    s += T(x0 + i * gw + gw / 2, y0 + 17, g.label, 'text-anchor="middle"');
  });
  return s;
}
const legend = (x, y) => SYS.map(([, name, col], i) => `<rect x="${x + i * 120}" y="${y - 10}" width="14" height="12" fill="${col}"/>` + T(x + 19 + i * 120, y, name)).join('');
// 실험 3
const e3 = JSON.parse(fs.readFileSync(path.join(D, 'exp3.json')));
let b = legend(250, 28);
b += bars(80, 330, 330, 240, 250, 50, ' ms', '(a) 실패를 알게 되기까지 평균 시간', ['smallbank', 'custom'].map((m) => ({ label: m, vals: SYS.map(([k, , col]) => ({ v: e3[`${m}-${k}`].mean, col })) })));
b += bars(540, 330, 330, 240, 100, 20, '%', '(b) 실패 중 프로세서가 미리 통보한 비율', ['smallbank', 'custom'].map((m) => ({ label: m, vals: SYS.map(([k, , col]) => ({ v: e3[`${m}-${k}`].aShare * 100, col })) })), (v) => `${v.toFixed(0)}%`);
b += T(470, 385, '배치 100, 1,000 TPS, s 1.0, 실험 4(fair-*) 실행의 tx 로그. 쓰기 tx만. 미리 통보는 약 100~145 ms, 피어 무효 판정은 약 205~235 ms', 'text-anchor="middle" fill="#555" font-size="11"');
fs.writeFileSync(path.join(F, 'fig-exp3-failure-notice.svg'), svg(940, 400, b));
// 실험 2: exp21.md 표 파싱
const md = fs.readFileSync(path.join(D, 'exp21.md'), 'utf8').split('\n');
const num = (c) => parseFloat(c);
const r2 = {}, r1 = {};
for (const l of md) {
  const c = l.split('|').map((x) => x.trim());
  if (c.length > 8 && (c[1] === 'smallbank' || c[1] === 'custom')) r2[`${c[1]}-${c[2]}`] = { sp: num(c[3]), peer: num(c[4]), ord: num(c[5]), led: num(c[6]), inv: num(c[7]) };
  if (c.length > 7 && /^(A1|FPP|HTF|BE-a\d)$/.test(c[1])) r1[c[1]] = { sp: num(c[2]), u2: num(c[3]), rest: num(c[4]) };
}
b = legend(380, 28);
const pan = [['peer', '피어 CPU (ms / 성공 tx)', 12, 2, ''], ['led', '원장 증가 (KB / 성공 tx)', 12, 2, ''], ['inv', '원장에 쌓인 무효 tx 비율', 70, 10, '%']];
pan.forEach(([k, title, max, step, unit], i) => {
  b += bars(70 + i * 380, 330, 290, 240, max, step, unit, `(${'abc'[i]}) ${title}`, ['smallbank', 'custom'].map((m) => ({ label: m, vals: SYS.map(([s, , col]) => ({ v: r2[`${m}-${s}`][k], col })) })), (v) => unit ? `${v.toFixed(0)}%` : v.toFixed(1));
});
b += T(570, 385, '1,000 TPS, 배치 100, s 1.0, 2회 평균. CPU는 cgroup 누적(org1+org2 피어), 원장은 org1 피어 블록 파일 증가량을 실행 전체의 성공 tx 수로 나눔', 'text-anchor="middle" fill="#555" font-size="11"');
fs.writeFileSync(path.join(F, 'fig-exp2-resources.svg'), svg(1140, 400, b));
// 실험 1
const S1 = [['A1', 'Fabric', '#6b7280'], ['FPP', 'Fabric++', '#d97706'], ['HTF', 'HTFabric', '#7c3aed'], ['BE-a0', 'Serializer α 0', '#93c5fd'], ['BE-a1', 'Serializer α 1', '#2563eb'], ['BE-a3', 'Serializer α 3', '#1e3a8a']];
b = S1.map(([, name, col], i) => `<rect x="${110 + i * 135}" y="18" width="14" height="12" fill="${col}"/>` + T(129 + i * 135, 28, name)).join('');
b += bars(80, 330, 380, 240, 50, 10, '%', '(a) 쓰기 성공률: User2(s 2.5) 대 나머지 4명(s 1.0)', [['u2', 'User2'], ['rest', '나머지 4명 평균']].map(([k, label]) => ({ label, vals: S1.map(([s, , col]) => ({ v: r1[s][k], col })) })), (v) => `${v.toFixed(0)}`);
b += bars(570, 330, 330, 240, 500, 100, '', '(b) 성공 tx / s', [{ label: '전체', vals: S1.map(([s, , col]) => ({ v: r1[s].sp, col })) }]);
b += T(490, 385, 'smallbank, 1,000 TPS, 배치 100, 3회 평균. User2 실패의 85~87%(Serializer·Fabric++)는 같은 배치의 앞선 쓰기를 읽어 버려지는 것이라 α와 무관', 'text-anchor="middle" fill="#555" font-size="11"');
fs.writeFileSync(path.join(F, 'fig-exp1-skewed-user.svg'), svg(980, 400, b));
