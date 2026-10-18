// §57 그림 1~3: 계좌 100, s 0~2 × 배치 100/500/1000 × 1,000 TPS (§54, 3회)
//   그림 1 블록당 처리 시간(분해) + 블록 간격, 그림 2 초당 성공 tx, 그림 3 배치별 최적 s
//   node cloudfigs2.js [출력 폴더]
const fs = require('fs'), path = require('path');
const { blockTimes } = require('./blocktime');
const R = path.join(__dirname, '../zipfbench/results/cloud');
const OUT = process.argv[2] || path.join(__dirname, '../../experiments/cloud-figs');
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
const SS = ['0', '0.5', '1.0', '1.5', '2.0'], BS = [100, 500, 1000], SYS = ['A1', 'BE'];

const D = {};
for (const b of BS) for (const s of SS) for (const sys of SYS) {
  const dir = path.join(R, `cloud-s${s}-b${b}`, sys, 'u0'); const reps = [];
  for (const rep of fs.readdirSync(dir)) {
    const d = path.join(dir, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
    const a = {};
    for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-')))
      for (const [k, x] of Object.entries(JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady.all)) a[k] = (a[k] || 0) + x;
    reps.push({ sp: a.success / dur, lat: a.latencySuccessSum / a.success, fail: 100 * (1 - a.success / a.total), ...blockTimes(d) });
  }
  const st = {}; for (const k of Object.keys(reps[0])) st[k] = [m(reps.map((r) => r[k])), sd(reps.map((r) => r[k]))];
  st.proc = [m(reps.map((r) => r.order + r.deliver + r.commit)), sd(reps.map((r) => r.order + r.deliver + r.commit))];
  st.n = reps.length;
  (D[b] ??= {})[s] ??= {}; D[b][s][sys] = st;
}
for (const b of BS) for (const s of SS) {
  const F = D[b][s].A1, S = D[b][s].BE;
  D[b][s].ratio = S.sp[0] / F.sp[0]; D[b][s].dLat = S.lat[0] - F.lat[0];
  D[b][s].power = (S.sp[0] / S.lat[0]) / (F.sp[0] / F.lat[0]);   // Kleinrock power(처리량/지연)의 비
}
fs.writeFileSync(path.join(OUT, 'fig123-data.json'), JSON.stringify(D, null, 1));

// ---- SVG 도우미 ----
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const C = { A1: '#8a8f98', BE: '#2563eb', 100: '#2563eb', 500: '#d97706', 1000: '#dc2626' };
const SEG = { order: '#f59e0b', deliver: '#60a5fa', commit: '#1e3a8a' };
const SEGF = { deliver: '#c7cbd1', commit: '#5b616b' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
const nice = (v) => { const p = 10 ** Math.floor(Math.log10(v)); for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p; };
function panel(x0, y0, w, h, ymax, title, ylabel, nt = 5) {
  const ym = (v) => y0 - (v / ymax) * h; let s = '';
  for (let i = 0; i <= nt; i++) { const v = ymax * i / nt, y = ym(v); s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="#e5e7eb"/>` + T(x0 - 6, y + 4, +v.toFixed(1), 'text-anchor="end" font-size="11"'); }
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  s += T(x0 + w / 2, y0 - h - 10, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  if (ylabel) s += T(x0 - 44, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 44} ${y0 - h / 2})"`);
  const xs = (i) => x0 + (i + 0.5) * w / SS.length;
  SS.forEach((v, i) => { s += T(xs(i), y0 + 16, v, 'text-anchor="middle"'); });
  s += T(x0 + w / 2, y0 + 33, 'Zipf s', 'text-anchor="middle" fill="#444"');
  return { s, ym, xs };
}
const errbar = (x, y1, y2, col = '#111') => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}"/><line x1="${x - 3}" y1="${y1}" x2="${x + 3}" y2="${y1}" stroke="${col}"/><line x1="${x - 3}" y1="${y2}" x2="${x + 3}" y2="${y2}" stroke="${col}"/>`;
const key = (x, y, items) => { let s = '', xx = x; for (const [lab, col, kind] of items) { s += kind === 'line' ? `<line x1="${xx}" y1="${y - 4}" x2="${xx + 18}" y2="${y - 4}" stroke="${col}" stroke-width="2.5"/><circle cx="${xx + 9}" cy="${y - 4}" r="3.5" fill="${col}"/>` : kind === 'dash' ? `<line x1="${xx}" y1="${y - 4}" x2="${xx + 18}" y2="${y - 4}" stroke="${col}" stroke-width="2" stroke-dasharray="4 3"/>` : `<rect x="${xx}" y="${y - 11}" width="14" height="12" fill="${col}"/>`; s += T(xx + 22, y, lab); xx += 30 + lab.length * 9.5; } return s; };
const foot = (W, H, t) => T(W / 2, H - 12, t, 'text-anchor="middle" fill="#555" font-size="11"');
const COND = 'smallbank, 계좌 100, 1,000 TPS, Query 50%, 사용자 5명, 긴급 0 · AWS 4 VM · 30초(앞 5초 제외) × 3회 평균';

// ---- 그림 1: 블록당 처리 시간 ----
{
  const W = 1080, H = 780, pw = 270, ph = 210, gx = 340, X0 = 95;
  let body = '';
  BS.forEach((b, j) => {
    const x0 = X0 + j * gx;
    // 위: 처리 시간 분해 (막대 쌓기)
    const top = Math.max(...SS.flatMap((s) => SYS.map((y) => D[b][s][y].proc[0] + D[b][s][y].proc[1])));
    const P = panel(x0, 335, pw, ph, nice(top * 1.15), `배치 ${b}`, j === 0 ? '블록 처리 시간 (ms)' : '');
    body += P.s;
    SS.forEach((s, i) => {
      const bw = 18;
      SYS.forEach((sys, k) => {
        const v = D[b][s][sys], x = P.xs(i) + (k ? 1 : -bw - 1); let acc = 0;
        for (const seg of ['order', 'deliver', 'commit']) {
          const h = v[seg][0]; if (h <= 0) continue;
          body += `<rect x="${x}" y="${P.ym(acc + h)}" width="${bw}" height="${P.ym(acc) - P.ym(acc + h)}" fill="${(sys === 'BE' ? SEG : SEGF)[seg]}"/>`; acc += h;
        }
        body += errbar(x + bw / 2, P.ym(v.proc[0] + v.proc[1]), P.ym(Math.max(0, v.proc[0] - v.proc[1])));
      });
    });
    // 아래: 블록 간격 (선)
    const top2 = Math.max(...SS.flatMap((s) => SYS.map((y) => D[b][s][y].interval[0])));
    const Q = panel(x0, 690, pw, ph, nice(top2 * 1.12), `배치 ${b}`, j === 0 ? '블록 간격 (ms)' : '');
    body += Q.s;
    for (const sys of SYS) {
      body += `<polyline points="${SS.map((s, i) => `${Q.xs(i)},${Q.ym(D[b][s][sys].interval[0])}`).join(' ')}" fill="none" stroke="${C[sys]}" stroke-width="2.2"/>`;
      SS.forEach((s, i) => { const v = D[b][s][sys].interval; body += `<circle cx="${Q.xs(i)}" cy="${Q.ym(v[0])}" r="3.8" fill="${C[sys]}"/>` + errbar(Q.xs(i), Q.ym(v[0] + v[1]), Q.ym(v[0] - v[1]), C[sys]); });
    }
    const ideal = b; // 1,000 TPS 에서 배치가 차는 시간
    body += `<line x1="${x0}" y1="${Q.ym(ideal)}" x2="${x0 + pw}" y2="${Q.ym(ideal)}" stroke="#111" stroke-dasharray="4 3"/>`;
  });
  body += T(40, 40, '(a) 블록 하나의 처리 시간: 배치 확정 → 피어 커밋 완료 (왼쪽 막대 Fabric, 오른쪽 막대 Serializer)', 'font-weight="bold" font-size="14"');
  body += key(60, 64, [['Serializer 정렬 왕복 (Kafka → 프로세서 → 오더러)', SEG.order], ['블록 쓰기·전달·피어 서명 검증', SEG.deliver], ['피어 MVCC 검증·커밋', SEG.commit], ['(Fabric은 같은 구간 회색)', SEGF.commit]]);
  body += T(40, 410, '(b) 블록 간격: 블록이 만들어지는 주기', 'font-weight="bold" font-size="14"');
  body += key(60, 434, [['Fabric (같은 소스, A1)', C.A1, 'line'], ['Serializer', C.BE, 'line'], ['1,000 TPS로 배치가 차는 시간', '#111', 'dash']]);
  body += foot(W, H, COND + ' · 막대는 ± 표준편차');
  fs.writeFileSync(path.join(OUT, 'fig1-block-time.svg'), svg(W, H, body));
}

// ---- 그림 2: 초당 성공 tx ----
{
  const W = 1080, H = 400, pw = 270, ph = 250, gx = 340, X0 = 95;
  let body = '';
  const top = nice(Math.max(...BS.flatMap((b) => SS.map((s) => D[b][s].A1.sp[0]))) * 1.1);
  BS.forEach((b, j) => {
    const P = panel(X0 + j * gx, 330, pw, ph, top, `배치 ${b}`, j === 0 ? '초당 성공한 tx 수' : '');
    body += P.s;
    for (const sys of SYS) {
      body += `<polyline points="${SS.map((s, i) => `${P.xs(i)},${P.ym(D[b][s][sys].sp[0])}`).join(' ')}" fill="none" stroke="${C[sys]}" stroke-width="2.4"/>`;
      SS.forEach((s, i) => { const v = D[b][s][sys].sp; body += `<circle cx="${P.xs(i)}" cy="${P.ym(v[0])}" r="4" fill="${C[sys]}"/>` + errbar(P.xs(i), P.ym(v[0] + v[1]), P.ym(v[0] - v[1]), C[sys]); });
    }
    SS.forEach((s, i) => { body += T(P.xs(i), P.ym(D[b][s].BE.sp[0]) - 10, `×${D[b][s].ratio.toFixed(2)}`, `text-anchor="middle" font-size="10.5" font-weight="bold" fill="${C.BE}"`); });
  });
  body += key(340, 30, [['Fabric (같은 소스, A1)', C.A1, 'line'], ['Serializer (ε .1 / .75)', C.BE, 'line']]);
  body += foot(W, H, COND + ' · 막대는 ± 표준편차 · 숫자는 Serializer / Fabric 배율');
  fs.writeFileSync(path.join(OUT, 'fig2-throughput.svg'), svg(W, H, body));
}

// ---- 그림 3: 배치별 최적 s ----
{
  const W = 1080, H = 470;
  let body = '';
  const best = Object.fromEntries(BS.map((b) => [b, SS.reduce((x, s) => D[b][s].power > D[b][x].power ? s : x, SS[0])]));
  // (a) power 비, 로그 축
  {
    const x0 = 95, y0 = 370, w = 400, h = 270, lo = Math.log(0.8), hi = Math.log(8);
    const ym = (v) => y0 - ((Math.log(v) - lo) / (hi - lo)) * h, xs = (i) => x0 + (i + 0.5) * w / SS.length;
    for (const t of [1, 1.5, 2, 3, 4, 6, 8]) body += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + T(x0 - 6, ym(t) + 4, t, 'text-anchor="end" font-size="11"');
    body += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
    body += `<line x1="${x0}" y1="${ym(1)}" x2="${x0 + w}" y2="${ym(1)}" stroke="#111" stroke-dasharray="4 3"/>`;
    SS.forEach((s, i) => { body += T(xs(i), y0 + 16, s, 'text-anchor="middle"'); });
    body += T(x0 + w / 2, y0 + 33, 'Zipf s', 'text-anchor="middle" fill="#444"');
    body += T(x0 - 50, y0 - h / 2, '종합 이득 (로그 축)', `text-anchor="middle" transform="rotate(-90 ${x0 - 50} ${y0 - h / 2})"`);
    body += T(x0 + w / 2, y0 - h - 34, '(a) 혼잡도별 종합 이득 = (성공 처리량 ÷ 커밋 지연) S / F', 'text-anchor="middle" font-weight="bold" font-size="13"');
    body += T(x0 + w / 2, y0 - h - 16, '1보다 크면 처리량 이득이 지연 손해보다 크다', 'text-anchor="middle" fill="#555" font-size="11"');
    for (const b of BS) {
      body += `<polyline points="${SS.map((s, i) => `${xs(i)},${ym(D[b][s].power)}`).join(' ')}" fill="none" stroke="${C[b]}" stroke-width="2.4"/>`;
      SS.forEach((s, i) => { body += `<circle cx="${xs(i)}" cy="${ym(D[b][s].power)}" r="4" fill="${C[b]}"/>`; });
      const i = SS.indexOf(best[b]), x = xs(i), y = ym(D[b][best[b]].power);
      const star = (cx, cy, r) => Array.from({ length: 10 }, (_, k) => { const a = Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy - rr * Math.sin(a)).toFixed(1)}`; }).join(' ');
      body += `<polygon points="${star(x, y, 11)}" fill="${C[b]}" stroke="#111" stroke-width="1"/>`;
      body += T(x - 6, y - 16, `배치 ${b}: ×${D[b][best[b]].power.toFixed(2)}`, `text-anchor="end" font-weight="bold" font-size="11.5" fill="${C[b]}" stroke="#fff" stroke-width="4" paint-order="stroke"`);
    }
    for (const b of BS) body += `<circle cx="${xs(2)}" cy="${ym(D[b]['1.0'].power)}" r="9" fill="none" stroke="#111" stroke-width="1.6"/>`;
    body += key(x0 + 10, y0 - h + 16, [['배치 100', C[100], 'line'], ['배치 500', C[500], 'line'], ['배치 1000', C[1000], 'line']]);
    body += `<circle cx="${x0 + 17}" cy="${y0 - h + 36}" r="8" fill="none" stroke="#111" stroke-width="1.6"/>` + T(x0 + 32, y0 - h + 40, '주 실험 조건 (s 1.0, 대표 혼잡도)');
    body += T(x0 + 32, y0 - h + 60, '★ 이점이 가장 큰 s = 측정 범위의 끝 (극단 혼잡)', 'fill="#333"');
  }
  // (b) 표: 배치 × s
  {
    const x0 = 560, y0 = 120, cw = 84, rh = 76;
    body += T(x0 + cw * 3, 66, '(b) 배치 × s: 처리량 배율 / 커밋 지연 차이 / Fabric 실패율', 'text-anchor="middle" font-weight="bold" font-size="13"');
    body += T(x0 + cw * 3, 84, '★ = 이점이 가장 큰 s (측정 범위 끝, Fabric 실패 86~94%) · 점선 칸 = 주 실험 조건 s 1.0', 'text-anchor="middle" fill="#555" font-size="11"');
    SS.forEach((s, i) => { body += T(x0 + cw * (i + 1.5), y0 - 8, `s ${s}`, 'text-anchor="middle" font-weight="bold"'); });
    const pmax = Math.max(...BS.flatMap((b) => SS.map((s) => D[b][s].power)));
    BS.forEach((b, r) => {
      const y = y0 + r * rh;
      body += T(x0 + cw * 0.5, y + rh / 2 + 4, `배치 ${b}`, `text-anchor="middle" font-weight="bold" fill="${C[b]}"`);
      SS.forEach((s, i) => {
        const v = D[b][s], t = Math.log(v.power) / Math.log(pmax), x = x0 + cw * (i + 1);
        const col = `rgba(37,99,235,${(0.08 + 0.55 * t).toFixed(2)})`, isB = best[b] === s;
        body += `<rect x="${x + 2}" y="${y + 2}" width="${cw - 4}" height="${rh - 4}" fill="${col}" stroke="${isB ? '#111' : 'none'}" stroke-width="${isB ? 2.5 : 0}" rx="4"/>`;
        if (s === '1.0') body += `<rect x="${x + 5}" y="${y + 5}" width="${cw - 10}" height="${rh - 10}" fill="none" stroke="#111" stroke-width="1.6" stroke-dasharray="4 3" rx="3"/>`;
        body += T(x + cw / 2, y + 24, `×${v.ratio.toFixed(2)}${isB ? ' ★' : ''}`, `text-anchor="middle" font-weight="bold" font-size="13.5"`);
        body += T(x + cw / 2, y + 43, `${v.dLat >= 0 ? '+' : ''}${v.dLat.toFixed(0)} ms`, 'text-anchor="middle" font-size="11.5"');
        body += T(x + cw / 2, y + 60, `실패 ${v.A1.fail[0].toFixed(0)}%`, 'text-anchor="middle" font-size="10.5" fill="#444"');
      });
    });
    body += T(x0 + cw * 3, y0 + 3 * rh + 22, '칸 색이 진할수록 종합 이득이 크다', 'text-anchor="middle" fill="#555" font-size="11"');
  }
  body += foot(W, H, COND + ' · 커밋 지연은 성공 tx 기준');
  fs.writeFileSync(path.join(OUT, 'fig3-best-s.svg'), svg(W, H, body));
  console.log('최적 s', best);
}

console.log('| 배치 | s | 블록 처리 F / S (정렬·전달·커밋) | 블록 간격 F / S | 블록당 tx F / S | 성공/s F / S | 배율 | 지연 차이 | 종합 이득 |');
console.log('|---|---|---|---|---|---|---|---|---|');
const f0 = (x) => x[0].toFixed(0);
for (const b of BS) for (const s of SS) { const F = D[b][s].A1, S = D[b][s].BE;
  console.log(`| ${b} | ${s} | ${f0(F.proc)} (${f0(F.deliver)}+${f0(F.commit)}) / ${f0(S.proc)} (${f0(S.order)}+${f0(S.deliver)}+${f0(S.commit)}) | ${f0(F.interval)} / ${f0(S.interval)} | ${f0(F.tx)} / ${f0(S.tx)} | ${F.sp[0].toFixed(1)} / ${S.sp[0].toFixed(1)} | ×${D[b][s].ratio.toFixed(2)} | ${D[b][s].dLat >= 0 ? '+' : ''}${D[b][s].dLat.toFixed(0)} | ×${D[b][s].power.toFixed(2)} |`); }
