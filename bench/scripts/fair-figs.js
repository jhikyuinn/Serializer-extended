// §84 실험 4 그림: fair.js 가 만든 fair-data.json 을 읽는다.
//   node fair-figs.js <fair-data.json> <figures 폴더>
const fs = require('fs'), path = require('path');
const D = JSON.parse(fs.readFileSync(process.argv[2])), OUT = process.argv[3];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${b}\n</svg>\n`;
const SYS = [['A1', 'Fabric', '#9ca3af'], ['FPP', 'Fabric++', '#a16207'], ['HTF', 'HTFabric', '#7c3aed'], ['BE05', 'S 1/0.5', '#93c5fd'], ['BE075', 'S 1/0.75 (논문)', '#2563eb'], ['BE1', 'S 1/1', '#1e3a8a']];
const get = (mode, u, lab, k) => { const rs = D[`${mode}|${u}|${lab}`]; return rs ? [mean(rs.map((r) => r[k])), sd(rs.map((r) => r[k]))] : null; };
function panel(x0, y0, w, h, lo, hi, ticks, ylabel, title, fmt) {
  const ym = (v) => y0 - (v - lo) / (hi - lo) * h; let s = '';
  for (const t of ticks) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, fmt(t), 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  s += T(x0 - 48, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 48} ${y0 - h / 2})"`);
  s += T(x0 + w / 2, y0 - h - 12, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  return { s, ym };
}
// 막대 묶음: 그룹(가로) × 시스템(색)
function bars(P, x0, w, groups, syss, val, fmt, lo) {
  let s = ''; const gw = w / groups.length, bw = Math.min(22, (gw - 20) / syss.length);
  groups.forEach(([gname, gkey], i) => {
    const cx = x0 + (i + 0.5) * gw;
    syss.forEach(([lab, , col], j) => {
      const v = val(gkey, lab); if (!v) return;
      const x = cx + (j - (syss.length - 1) / 2) * (bw + 2) - bw / 2;
      s += `<rect x="${x}" y="${P.ym(v[0])}" width="${bw}" height="${P.ym(lo) - P.ym(v[0])}" fill="${col}"/>`;
      if (v[1]) s += `<line x1="${x + bw / 2}" y1="${P.ym(v[0] + v[1])}" x2="${x + bw / 2}" y2="${P.ym(v[0] - v[1])}" stroke="#111"/>`;
      s += T(x + bw / 2, P.ym(v[0] + v[1]) - 4, fmt(v[0]), 'text-anchor="middle" font-size="9"');
    });
    s += T(cx, P.ym(lo) + 18, gname, 'text-anchor="middle" font-size="12"');
  });
  return s;
}
const legend = (x, y, syss) => syss.map(([, name, col], i) => `<rect x="${x + i * 140}" y="${y - 11}" width="14" height="12" fill="${col}"/>` + T(x + i * 140 + 19, y, name, 'font-size="11.5"')).join('');
const foot = (W, H, t) => T(W / 2, H - 12, t, 'text-anchor="middle" fill="#555" font-size="11"');
const COND = 'AWS 4 VM, 1,000 TPS, 배치 100, 사용자 5명(지연 4.5/50/50/50/100 ms 흉내), 30초(앞 5초 제외) × 3회 평균 ± 표준편차';
const save = (n, W, H, b) => fs.writeFileSync(path.join(OUT, `${n}.svg`), svg(W, H, b));

// F1 성능: 초당 성공(smallbank, custom) + Query 성공률(smallbank), 긴급 끔
{
  const W = 1100, H = 440; let b = '';
  const A = panel(80, 350, 600, 260, 0, 800, [0, 200, 400, 600, 800], '초당 성공 tx', '(a) 초당 성공 (긴급 끔)', (v) => v);
  b += A.s + bars(A, 80, 600, [['smallbank (계좌 100, s 1.0)', 'smallbank'], ['custom (인기 키 0.2/0.1)', 'custom']], SYS, (g, l) => get(g, 'u0', l, 'sp'), (v) => v.toFixed(0), 0);
  const Q = panel(780, 350, 290, 260, 0, 80, [0, 20, 40, 60, 80], 'Query 성공률 (%)', '(b) 읽기 전용 tx 성공률 (smallbank)', (v) => v);
  b += Q.s + bars(Q, 780, 290, [['smallbank', 'smallbank']], SYS, (g, l) => get(g, 'u0', l, 'qrate'), (v) => v.toFixed(0), 0);
  b += legend(130, 34, SYS) + foot(W, H, COND + '. S = Serializer(긴급 ε / 일반 ε)');
  save('fig1-performance', W, H, b);
}
// F2 공정성: 사용자별 쓰기 성공률(smallbank) + Jain·최소/최대(두 부하), 긴급 끔
{
  const W = 1100, H = 460; let b = '';
  const U = ['User1', 'User2', 'User3', 'User4', 'User5'], UL = ['U1 4.5ms', 'U2 50', 'U3 50', 'U4 50', 'U5 100'];
  const A = panel(80, 360, 440, 270, 0, 0.6, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], '쓰기 tx 성공률', '(a) 사용자별 쓰기 성공률 (smallbank, 긴급 끔)', (v) => `${(v * 100).toFixed(0)}%`);
  b += A.s; const xs = (i) => 80 + (i + 0.5) * 440 / 5;
  UL.forEach((l, i) => { b += T(xs(i), 378, l, 'text-anchor="middle" font-size="11"'); });
  for (const [lab, , col] of SYS) { const rs = D[`smallbank|u0|${lab}`]; if (!rs) continue;
    const pts = U.map((u, i) => [xs(i), mean(rs.map((r) => r.perUser[u]))]);
    b += `<polyline points="${pts.map(([x, v]) => `${x},${A.ym(v)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2.3"/>` + pts.map(([x, v]) => `<circle cx="${x}" cy="${A.ym(v)}" r="3.8" fill="${col}"/>`).join(''); }
  const J = panel(620, 360, 450, 270, 0.9, 1.0, [0.9, 0.92, 0.94, 0.96, 0.98, 1.0], 'Jain 지수', '(b) 공정성: Jain 지수 (긴급 끔, 막대 위 = 최소/최대)', (v) => v.toFixed(2));
  b += J.s;
  const gw = 450 / 2, bw = 26;
  [['smallbank', 'smallbank'], ['custom', 'custom']].forEach(([gname, g], i) => {
    const cx = 620 + (i + 0.5) * gw;
    SYS.forEach(([lab, , col], j) => { const v = get(g, 'u0', lab, 'jain'), mm = get(g, 'u0', lab, 'minmax'); if (!v) return;
      const x = cx + (j - 2.5) * (bw + 3) - bw / 2;
      b += `<rect x="${x}" y="${J.ym(v[0])}" width="${bw}" height="${J.ym(0.9) - J.ym(v[0])}" fill="${col}"/>` + T(x + bw / 2, J.ym(v[0]) - 4, mm[0].toFixed(2), 'text-anchor="middle" font-size="9"'); });
    b += T(cx, 378, gname, 'text-anchor="middle"');
  });
  b += legend(130, 34, SYS) + foot(W, H, COND + '. Jain = (Σx)²/(n·Σx²), x = 사용자별 쓰기 성공률. 최소/최대 = 가장 불리한 / 가장 유리한 사용자');
  save('fig2-fairness', W, H, b);
}
// F3 긴급 tx 와 α: 긴급 성공률(긴급 켬), VIP 제외 Jain, α 별 Jain·성공(smallbank·custom, 긴급 끔)
{
  const W = 1100, H = 440; const S2 = SYS.filter(([l]) => l !== 'A1'); let b = '';
  const A = panel(80, 350, 460, 260, 0, 100, [0, 20, 40, 60, 80, 100], '긴급 tx 성공률 (%)', '(a) 긴급 tx 성공률 (긴급 켬, VIP = User3)', (v) => v);
  b += A.s + bars(A, 80, 460, [['smallbank', 'smallbank'], ['custom', 'custom']], S2, (g, l) => get(g, 'u1', l, 'urg'), (v) => v.toFixed(0), 0);
  const AL = [['BE075-a0', 'α 0'], ['BE075', 'α 1(기본)'], ['BE075-a3', 'α 3']];
  const P = panel(660, 350, 410, 260, 0.9, 1.0, [0.9, 0.92, 0.94, 0.96, 0.98, 1.0], 'Jain 지수', '(b) abort 점수 α 별 공정성 (Serializer 논문 설정, 긴급 끔)', (v) => v.toFixed(2));
  b += P.s + bars(P, 660, 410, [['smallbank', 'smallbank'], ['custom', 'custom']], AL.map(([l, n], i) => [l, n, ['#bfdbfe', '#2563eb', '#1e3a8a'][i]]), (g, l) => get(g, 'u0', l, 'jain'), (v) => v.toFixed(3), 0.9);
  b += legend(100, 34, S2) + AL.map(([, n], i) => `<rect x="${760 + i * 100}" y="23" width="14" height="12" fill="${['#bfdbfe', '#2563eb', '#1e3a8a'][i]}"/>` + T(779 + i * 100, 34, n, 'font-size="11.5"')).join('');
  b += foot(W, H, COND + '. Fabric 은 긴급 개념이 없어 (a)에서 뺐다');
  save('fig3-urgent-alpha', W, H, b);
}
console.log('ok');
