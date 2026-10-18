// §76 ε 실험 논문용 그림 P1~P4. 입력: eps-tps/epssim-custom-data.json, epssim-data.json (epssim-*-figs.js 가 만든 것)
//   node epssim-paper-figs.js [eps-tps 폴더]
const fs = require('fs'), path = require('path');
const DIR = process.argv[2] || path.join(__dirname, '../../experiments/02-epsilon-realtime');
// 정리된 폴더(§82)는 data/ 와 figures/ 로 나뉘어 있다. 예전 평평한 폴더도 읽는다
const DATA = fs.existsSync(path.join(DIR, 'data')) ? path.join(DIR, 'data') : DIR;
const FIGD = fs.existsSync(path.join(DIR, 'figures')) ? path.join(DIR, 'figures') : DIR;
const C = JSON.parse(fs.readFileSync(path.join(DATA, 'epssim-custom-data.json')));
const S = JSON.parse(fs.readFileSync(path.join(DATA, 'epssim-data.json')));
const EPS = [['0.00', '0.00', '0'], ['0.25', '0.25', '0.25'], ['0.50', '0.50', '0.5'], ['0.75', '0.75', '0.75'], ['1.00', '1.00', '1']];
const EPSP = ['0.10', '0.75']; // 긴급 0.1·일반 0.75 조건(논문 설정은 긴급 1·일반 0.75, §83)
const ck = (u, h, b, e) => `${u}|${h}|${b}|${e[0]}|${e[1]}`;
const sk = (u, s, b, e) => `${u}|${s}|${b}|${e[0]}|${e[1]}`;
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
const BC = { 1000: '#2563eb', 5000: '#d97706', 10000: '#dc2626' };
const key = (x, y, items) => items.map(([lab, col, dash], i) => `<line x1="${x + i * 150}" y1="${y - 4}" x2="${x + i * 150 + 20}" y2="${y - 4}" stroke="${col}" stroke-width="2.5"${dash ? ' stroke-dasharray="5 3"' : ''}/>` + T(x + i * 150 + 25, y, lab)).join('');
// 축: kind 'lin' | 'log', xs: ε 범주
function axes(x0, y0, w, h, lo, hi, ticks, kind, ylabel, title, fmt, xcats, xlabel) {
  const ym = kind === 'log' ? (v) => y0 - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * h : (v) => y0 - (v - lo) / (hi - lo) * h;
  let s = '';
  for (const t of ticks) s += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, fmt(t), 'text-anchor="end" font-size="11"');
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  s += T(x0 - 50, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 50} ${y0 - h / 2})"`);
  s += T(x0 + w / 2, y0 - h - 12, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  const xs = (i) => x0 + (i + 0.5) * w / xcats.length;
  xcats.forEach((c, i) => { s += T(xs(i), y0 + 16, c, 'text-anchor="middle"'); });
  s += T(x0 + w / 2, y0 + 34, xlabel, 'text-anchor="middle" fill="#444" font-size="11.5"');
  return { s, ym, xs };
}
const kfmt = (v) => v >= 1000 ? `${v / 1000}k` : `${v}`;
const msfmt = (v) => v >= 1000 ? `${v / 1000} s` : `${v} ms`;
const line = (P, pts, col, dash) => `<polyline points="${pts.map(([i, v]) => `${P.xs(i)},${P.ym(v)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2.3"${dash ? ' stroke-dasharray="5 3"' : ''}/>` + pts.map(([i, v]) => `<circle cx="${P.xs(i)}" cy="${P.ym(v)}" r="4" fill="${dash ? '#fff' : col}" stroke="${col}" stroke-width="1.8"/>`).join('');
const paperMark = (P, xi, v, col) => { const x = Number.isInteger(xi) ? P.xs(xi) : P.xs(Math.floor(xi)) + (xi % 1) * (P.xs(1) - P.xs(0)); return `<path d="M${x} ${P.ym(v) - 7} l6 7 l-6 7 l-6 -7z" fill="#fff" stroke="${col}" stroke-width="1.6"/>`; };
const EC = EPS.map((e) => e[2]);
const H0 = '0.20/0.10';
const save = (name, W, H, body) => fs.writeFileSync(path.join(FIGD, `${name}.svg`), svg(W, H, body));

// ---- P1: 맞교환 (custom, 기본 혼잡, 긴급 끔) ----
{
  const W = 1040, H = 450; let b = '';
  const A = axes(90, 360, 380, 270, 0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1], 'lin', '배치 안에서 살린 tx 비율', '(a) 이득: 살린 tx 비율', (v) => `${v * 100}%`, EC, 'ε (긴급·일반 같은 값)');
  b += A.s;
  const P = axes(600, 360, 380, 270, 1000, 100000, [1000, 3000, 10000, 30000, 100000], 'log', '따라갈 수 있는 최대 TPS (로그)', '(b) 비용: 실시간 처리 한도', kfmt, EC, 'ε (긴급·일반 같은 값)');
  b += P.s;
  for (const bs of [1000, 5000, 10000]) {
    const r = EPS.map((e, i) => [i, C.B[ck(false, H0, bs, e)]]);
    b += line(A, r.map(([i, x]) => [i, x.valid]), BC[bs]);
    b += `<line x1="${A.xs(0) - 20}" y1="${A.ym(r[0][1].fab)}" x2="${A.xs(4) + 20}" y2="${A.ym(r[0][1].fab)}" stroke="${BC[bs]}" stroke-dasharray="2 3" stroke-opacity="0.5"/>`;
    b += line(P, r.map(([i, x]) => [i, x.cap]), BC[bs]);
    b += line(P, r.map(([i, x]) => [i, x.capW]), BC[bs], true);
    const pp = C.B[ck(false, H0, bs, EPSP)];
    b += paperMark(A, 3, pp.valid, BC[bs]) + paperMark(P, 3, pp.cap, BC[bs]);
  }
  b += key(250, 40, [['배치 1000', BC[1000]], ['배치 5000', BC[5000]], ['배치 10000', BC[10000]]]);
  b += T(250, 62, '(b) 실선 = 평균 정렬 기준, 점선 = 최악 배치 기준 · (a) 옅은 점선 = 도착 순서 그대로 · ◇ = 일반 ε 0.75(긴급 끔이면 논문 설정 긴급 1·일반 0.75와 같다)', 'font-size="11" fill="#444"');
  b += T(W / 2, H - 12, 'custom 부하(키 10,000, 인기 키 100, 읽기 4·쓰기 4, 인기 키 확률 0.2/0.1), 긴급 끔 · 실제 정렬 시간 + 경로 비용 10 ms + 0.02 ms/tx', 'text-anchor="middle" fill="#555" font-size="11"');
  save('figP1-tradeoff', W, H, b);
}
// ---- P2: 실시간성 — TPS 별 정렬 지연과 마감 위반 (custom, 배치 10000, 기본 혼잡) ----
{
  const W = 1040, H = 450; let b = '';
  const TPS = [1000, 2000, 5000, 10000, 20000], cats = TPS.map(kfmt);
  const EC5 = ['#16a34a', '#0891b2', '#2563eb', '#d97706', '#dc2626'];
  const A = axes(90, 360, 380, 270, 100, 10000, [100, 300, 1000, 3000, 10000], 'log', '정렬 지연 평균 (로그)', '(a) 정렬 지연: 배치가 찬 뒤 결과까지', msfmt, cats, '도착 TPS');
  b += A.s + `<line x1="90" y1="${A.ym(1000)}" x2="470" y2="${A.ym(1000)}" stroke="#111" stroke-dasharray="5 3"/>` + T(466, A.ym(1000) - 5, '마감 1 s', 'text-anchor="end" font-size="11"');
  const P = axes(600, 360, 380, 270, 0, 1, [0, 0.25, 0.5, 0.75, 1], 'lin', '1 s 마감 위반 비율 (배치)', '(b) 마감 위반', (v) => `${v * 100}%`, cats, '도착 TPS');
  b += P.s;
  EPS.forEach((e, j) => {
    const t = C.T[ck(false, H0, 10000, e)];
    b += line(A, t.map((x, i) => [i, x.om]), EC5[j]) + line(P, t.map((x, i) => [i, x.miss]), EC5[j]);
  });
  b += key(150, 40, EPS.map((e, j) => [`ε ${e[2]}`, EC5[j]]).slice(0, 5));
  b += T(W / 2, H - 12, 'custom 부하, 배치 10,000, 인기 키 확률 0.2/0.1, 긴급 끔 · 배치 12개를 실제로 정렬한 시간으로 계산(오더러 lock-step) · (b) ε 0~0.5 는 모두 0%', 'text-anchor="middle" fill="#555" font-size="11"');
  save('figP2-realtime', W, H, b);
}
// ---- P3: 긴급 tx (custom, 기본 혼잡, 긴급 켬) ----
{
  const W = 1040, H = 450; let b = '';
  const A = axes(90, 360, 380, 270, 0, 1, [0, 0.25, 0.5, 0.75, 1], 'lin', '긴급 tx 생존율', '(a) 긴급 tx 생존율', (v) => `${v * 100}%`, EC, 'ε (긴급·일반 같은 값)');
  const P = axes(600, 360, 380, 270, 0, 60, [0, 10, 20, 30, 40, 50, 60], 'lin', '배치당 정렬 시간 (ms)', '(b) 비용: 긴급 켬일 때 정렬 시간', (v) => v, EC, 'ε (긴급·일반 같은 값)');
  b += A.s + P.s;
  for (const bs of [1000, 5000, 10000]) {
    const r = EPS.map((e, i) => [i, C.B[ck(true, H0, bs, e)]]);
    b += line(A, r.map(([i, x]) => [i, x.urg]), BC[bs]) + line(P, r.map(([i, x]) => [i, x.sm]), BC[bs]);
    const pp = C.B[ck(true, H0, bs, EPSP)];
    b += paperMark(A, 0.4, pp.urg, BC[bs]); // ε_urgent 0.1 = 0 과 0.25 사이(0.4 칸)
  }
  b += key(250, 40, [['배치 1000', BC[1000]], ['배치 5000', BC[5000]], ['배치 10000', BC[10000]]]);
  b += T(250, 62, '◇ = 긴급 0.1·일반 0.75 조건(가로 0.1 위치). 논문 설정(긴급 1·일반 0.75)은 클라우드 §81-B', 'font-size="11" fill="#444"');
  b += T(W / 2, H - 12, 'custom 부하, 인기 키 확률 0.2/0.1, VIP(User3)의 쓰기 = 긴급(전체 쓰기의 약 20%)', 'text-anchor="middle" fill="#555" font-size="11"');
  save('figP3-urgent', W, H, b);
}
// ---- P4: 혼잡 × 비용 (smallbank 와 custom, 배치 10000, 긴급 끔) ----
{
  const W = 1040, H = 450; let b = '';
  const SC = { '1.0': '#2563eb', '1.5': '#d97706', '2.0': '#dc2626' };
  const HC = { '0.20/0.10': '#2563eb', '0.40/0.20': '#d97706', '0.60/0.30': '#dc2626' };
  const A = axes(90, 360, 380, 270, 0.1, 10000, [0.1, 1, 10, 100, 1000, 10000], 'log', '배치당 정렬 시간 (ms, 로그)', '(a) smallbank: 혼잡(Zipf s)별 정렬 시간', (v) => v >= 1000 ? `${v / 1000}k` : v, EC, 'ε');
  const P = axes(600, 360, 380, 270, 0.1, 10000, [0.1, 1, 10, 100, 1000, 10000], 'log', '배치당 정렬 시간 (ms, 로그)', '(b) custom: 혼잡(인기 키 확률)별 정렬 시간', (v) => v >= 1000 ? `${v / 1000}k` : v, EC, 'ε');
  b += A.s + P.s;
  for (const s of ['1.0', '1.5', '2.0']) b += line(A, EPS.map((e, i) => [i, S.B[sk(false, s, 10000, e)].sm]), SC[s]);
  for (const h of Object.keys(HC)) b += line(P, EPS.map((e, i) => [i, C.B[ck(false, h, 10000, e)].sm]), HC[h]);
  for (const Q of [A, P]) b += `<line x1="${Q.xs(0) - 30}" y1="${Q.ym(1000)}" x2="${Q.xs(4) + 30}" y2="${Q.ym(1000)}" stroke="#111" stroke-dasharray="5 3"/>`;
  b += key(110, 40, [['s 1.0 / 기본 0.2/0.1', '#2563eb'], ['s 1.5 / 중간 0.4/0.2', '#d97706'], ['s 2.0 / 높음 0.6/0.3', '#dc2626']].map(([l, c]) => [l, c])).replace(/x1="(\d+)"/g, (m) => m);
  b += T(W / 2, H - 12, '배치 10,000, 긴급 끔, 평균 정렬 시간. 점선 = 1 s', 'text-anchor="middle" fill="#555" font-size="11"');
  save('figP4-contention', W, H, b);
}
console.log('ok');

// ---- P5: 클라우드 실제 경로 확인 (§77). results/epsc-* 에서 읽는다 ----
{
  const RR = path.join(__dirname, '../zipfbench/results');
  const runs = (name) => { const base = path.join(RR, name, 'BE', 'u0'); if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).map((rep) => path.join(base, rep)).filter((d) => fs.existsSync(path.join(d, 'meta.json'))).map((d) => {
      const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), dur = meta.duration - (meta.warmupSec || 0), a = {};
      for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) for (const [k, x] of Object.entries(JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady.all)) a[k] = (a[k] || 0) + x;
      const b = +meta.batchSize, pl = fs.readFileSync(path.join(d, 'processor.log'), 'utf8').split('\n');
      const bt = pl.map((l) => l.match(/\[Batch\] n=(\d+) ordered=(\d+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
      const tm = pl.map((l) => l.match(/\[Timing\] n=(\d+).*sched=([\d.]+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
      const mn = (x) => x.reduce((p, q) => p + q, 0) / x.length;
      return { sp: a.success / dur, lat: a.latencySuccessSum / a.success, inb: mn(bt.map((m) => +m[2] / +m[1])), sch: mn(tm.map((m) => +m[2])) };
    }); };
  const agg = (rs, k) => { const v = rs.map((r) => r[k]), m = v.reduce((p, q) => p + q, 0) / v.length; return [m, v.length > 1 ? Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / (v.length - 1)) : 0]; };
  const R = {}; for (const e of ['0', '1']) { for (const t of [1000, 3000]) R[`${e}-${t}-1000`] = runs(`epsc-e${e}-t${t}-b1000`); R[`${e}-2000-10000`] = runs(`epsc-e${e}-t2000-b10000`); }
  if (R['0-1000-1000'].length) {
    const W = 1100, H = 470; let b = '';
    const E0 = '#16a34a', E1 = '#dc2626', SIMC = '#9ca3af';
    const bar = (P, xc, w, v, col, err, hollow) => `<rect x="${xc - w / 2}" y="${P.ym(v)}" width="${w}" height="${P.ym(0) - P.ym(v)}" fill="${hollow ? '#fff' : col}" stroke="${col}" stroke-width="${hollow ? 1.8 : 0}"/>` + (err ? `<line x1="${xc}" y1="${P.ym(v + err)}" x2="${xc}" y2="${P.ym(Math.max(0, v - err))}" stroke="#111"/>` : '');
    // (a) 배치 안 살린 비율: 시뮬 대 클라우드
    const ca = ['배치 1000', '배치 10000'];
    const A = axes(80, 370, 260, 270, 0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1], 'lin', '배치 안 살린 비율', '(a) 시뮬레이션 대 실제: 배치 안 살린 비율', (v) => `${v * 100}%`, ca, '');
    b += A.s;
    const simv = { '0-1000': 0.445, '1-1000': 0.798, '0-10000': 0.138, '1-10000': 0.186 };
    [[1000, 0], [10000, 1]].forEach(([bs, i]) => {
      const cloud = (e) => agg(bs === 1000 ? R[`${e}-1000-1000`] : R[`${e}-2000-10000`], 'inb')[0];
      [['0', E0, -36], ['1', E1, 12]].forEach(([e, col, dx]) => { b += bar(A, A.xs(i) + dx, 20, simv[`${e}-${bs}`], col, 0, true) + bar(A, A.xs(i) + dx + 22, 20, cloud(e), col); });
    });
    b += T(210, 112, '빈 막대 = 시뮬레이션, 채운 막대 = 클라우드', 'text-anchor="middle" font-size="10.5" fill="#444"');
    // (b) 배치 1000: 초당 성공 (TPS 1000 / 3000)
    const cb = ['1,000 TPS', '3,000 TPS'];
    const Bp = axes(450, 370, 260, 270, 0, 800, [0, 200, 400, 600, 800], 'lin', '초당 성공 tx', '(b) 배치 1000: 초당 성공 (3회 ± 표준편차)', (v) => v, cb, '');
    b += Bp.s;
    [1000, 3000].forEach((t, i) => [['0', E0, -14], ['1', E1, 14]].forEach(([e, col, dx]) => { const [m, s] = agg(R[`${e}-${t}-1000`], 'sp'); b += bar(Bp, Bp.xs(i) + dx, 24, m, col, s) + T(Bp.xs(i) + dx, Bp.ym(m + s) - 6, m.toFixed(0), `text-anchor="middle" font-size="10.5" fill="${col}"`); }));
    // (c) 커밋 지연 (로그)
    const cc = ['b1000·1k', 'b1000·3k', 'b10000·2k'];
    const Cp = axes(820, 370, 250, 270, 100, 30000, [100, 300, 1000, 3000, 10000, 30000], 'log', '커밋 지연 (로그)', '(c) 커밋 지연', (v) => v >= 1000 ? `${v / 1000} s` : `${v} ms`, cc, '');
    b += Cp.s;
    [['0-1000-1000', 0], ['0-3000-1000', 1], ['0-2000-10000', 2]].forEach(([k0, i]) => [['0', E0, -14], ['1', E1, 14]].forEach(([e, col, dx]) => {
      const k = `${e}${k0.slice(1)}`, [m] = agg(R[k], 'lat'), y = Cp.ym(m);
      b += `<rect x="${Cp.xs(i) + dx - 12}" y="${y}" width="24" height="${Cp.ym(100) - y}" fill="${col}"/>` + T(Cp.xs(i) + dx, y - 5, m >= 1000 ? `${(m / 1000).toFixed(1)}s` : `${m.toFixed(0)}`, `text-anchor="middle" font-size="10" fill="${col}"`);
    }));
    b += key(380, 40, [['ε 0', E0], ['ε 1', E1]]);
    const s10 = agg(R['1-2000-10000'], 'sch')[0];
    b += T(W / 2, H - 30, `custom 부하(인기 키 0.2/0.1), 긴급 끔, AWS 4 VM, 30초(배치 10000 은 60초, 1회). 배치 1000·3,000 TPS 의 ε 1: 블록당 유효 tx 1.8배로 피어 커밋이 밀려 지연 11.8 s, 성공 급감.`, 'text-anchor="middle" fill="#555" font-size="11"');
    b += T(W / 2, H - 12, `배치 10000·ε 1: 정렬 평균 ${s10.toFixed(0)} ms 가 지연에 더해져 배치 안 이득(+4%p)이 상쇄됨.`, 'text-anchor="middle" fill="#555" font-size="11"');
    save('figP5-cloud', W, H, b);
  }
}

// ---- P6: 경계 TPS (§81 A + §77). custom, 배치 1000, 긴급 끔, ε 0 / 0.5 / 1, TPS 1000~3000, 3회 ----
{
  const RR = path.join(__dirname, '../zipfbench/results');
  const one = (name) => { const base = path.join(RR, name, 'BE', 'u0'); if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).map((r) => path.join(base, r)).filter((d) => fs.existsSync(path.join(d, 'meta.json'))).map((d) => {
      const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), dur = meta.duration - (meta.warmupSec || 0), a = {};
      for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) for (const [k, x] of Object.entries(JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady.all)) a[k] = (a[k] || 0) + x;
      return { sp: a.success / dur, lat: a.latencySuccessSum / a.success }; }); };
  const nm = (e, t) => (t === 1000 || t === 3000) ? `epsc-e${e}-t${t}-b1000` : `gapA-e${e}-t${t}`;
  const TP = [1000, 1500, 2000, 2500, 3000], E = [['0', '#16a34a'], ['0.5', '#2563eb'], ['1', '#dc2626']];
  const st = (rs, k) => { const v = rs.map((r) => r[k]), m = v.reduce((p, q) => p + q, 0) / v.length; return [m, v.length > 1 ? Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / (v.length - 1)) : 0]; };
  if (one('gapA-e0-t2000').length) {
    const W = 1040, H = 450; let b = '';
    const cats = TP.map((t) => t.toLocaleString());
    const A = axes(90, 360, 380, 270, 0, 800, [0, 200, 400, 600, 800], 'lin', '초당 성공 tx', '(a) 초당 성공 (3회 ± 표준편차)', (v) => v, cats, '보낸 TPS');
    const P = axes(600, 360, 380, 270, 300, 30000, [300, 1000, 3000, 10000, 30000], 'log', '커밋 지연 (로그)', '(b) 커밋 지연', (v) => v >= 1000 ? `${v / 1000} s` : `${v} ms`, cats, '보낸 TPS');
    b += A.s + P.s;
    b += `<rect x="${A.xs(2) - 34}" y="${A.ym(800)}" width="68" height="${A.ym(0) - A.ym(800)}" fill="#fef3c7" opacity="0.5"/>` + T(A.xs(2), A.ym(800) + 14, '경계', 'text-anchor="middle" font-size="11" fill="#92400e"');
    for (const [e, col] of E) {
      const pts = TP.map((t, i) => [i, one(nm(e, t))]).filter(([, rs]) => rs.length);
      b += line(A, pts.map(([i, rs]) => [i, st(rs, 'sp')[0]]), col) + line(P, pts.map(([i, rs]) => [i, st(rs, 'lat')[0]]), col);
      for (const [i, rs] of pts) { const [m, s] = st(rs, 'sp'); b += `<line x1="${A.xs(i)}" y1="${A.ym(m + s)}" x2="${A.xs(i)}" y2="${A.ym(Math.max(0, m - s))}" stroke="${col}"/>`; }
    }
    b += key(330, 40, E.map(([e, col]) => [`ε ${e}`, col]));
    b += T(W / 2, H - 30, 'custom 부하(인기 키 0.2/0.1), 배치 1,000, 긴급 끔, AWS 4 VM. 1,500 TPS 이하는 ε 1, 약 2,000 은 ε 0~0.5, 2,500 이상은 ε 0 이 가장 많이 살린다.', 'text-anchor="middle" fill="#555" font-size="11"');
    b += T(W / 2, H - 12, 'ε 1 이 높은 TPS 에서 무너지는 이유: 더 많이 살린 tx 를 피어(16 vCPU, 2개)가 제때 커밋하지 못해 지연이 쌓이고 배치 사이 낡은 읽기가 늘어난다(§77).', 'text-anchor="middle" fill="#555" font-size="11"');
    save('figP6-boundary', W, H, b);
  }
}
