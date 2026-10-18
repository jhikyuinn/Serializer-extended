// §75 ε 시뮬레이션 custom 부하 요약 + 그림. 입력: Serializer/kafka/processor/epssim-custom.out
//   node epssim-custom-figs.js [입력] [출력 폴더]
// 혼잡 = 인기 키 확률 hr/hw (0.2/0.1 기본, 0.4/0.2, 0.6/0.3). 경로 비용 10 ms + 0.02 ms × 배치.
const fs = require('fs'), path = require('path');
const IN = process.argv[2] || path.join(__dirname, '../data/epssim-custom.out');
const OUT = process.argv[3] || path.join(__dirname, '../figures');
const g = (l, k) => { const m = l.match(new RegExp(`\\b${k}=([^ ]+)`)); return m ? m[1] : undefined; };
const EPS = [['0.00', '0.00', '0'], ['0.25', '0.25', '0.25'], ['0.50', '0.50', '0.5'], ['0.10', '0.75', '0.1/0.75'], ['0.75', '0.75', '0.75'], ['1.00', '1.00', '1']];
const HS = [['0.20', '0.10', '기본 0.2/0.1'], ['0.40', '0.20', '중간 0.4/0.2'], ['0.60', '0.30', '높음 0.6/0.3']];
const key = (u, h, b, e) => `${u}|${h}|${b}|${e[0]}|${e[1]}`;
const B = {}, T = {};
for (const l of fs.readFileSync(IN, 'utf8').split('\n')) {
  if (!l.startsWith('[EPSSIM') || !l.includes('mode=custom')) continue;
  const ur = g(l, 'urgent'), u = ur === 'true' || ur === '1';
  const h = `${(+g(l, 'hr')).toFixed(2)}/${(+g(l, 'hw')).toFixed(2)}`, b = +g(l, 'batch');
  const e = [(+g(l, 'epsU')).toFixed(2), (+g(l, 'epsL')).toFixed(2)], k = key(u, h, b, e);
  if (l.startsWith('[EPSSIM-BATCH]')) {
    if (/TIMEOUT/.test(l)) { B[k] = { timeout: true }; continue; }
    const ovh = 10 + 0.02 * b, sm = +g(l, 'sort_mean'), sx = +g(l, 'sort_max');
    B[k] = { sm, sx, valid: +g(l, 'valid'), fab: +g(l, 'fabric_valid'), urg: +g(l, 'urgent_ok'), jain: +g(l, 'jain'), cap: b * 1000 / (ovh + sm), capW: b * 1000 / (ovh + sx) };
  } else (T[k] ??= []).push({ tps: +g(l, 'tps'), om: +g(l, 'ord_mean'), miss: +g(l, 'miss') });
}
fs.writeFileSync(path.join(OUT, 'epssim-custom-data.json'), JSON.stringify({ B, T }, null, 1));
const f = (x, d = 1) => (x === undefined || Number.isNaN(x)) ? '-' : x.toFixed(d);
const hk = (h) => `${h[0]}/${h[1]}`;
for (const u of [false, true]) for (const b of [1000, 5000, 10000]) {
  console.log(`\n### custom, 긴급 ${u ? '켬' : '끔'}, 배치 ${b} — 정렬 ms 평균[최대] · 따라갈 TPS 평균/최악 · 살린 비율 (Fabric 도착순)${u ? ' · 긴급 생존' : ''} · Jain`);
  console.log(`| ε | ${HS.map((h) => h[2]).join(' | ')} |\n|---|---|---|---|`);
  for (const e of EPS) console.log(`| ${e[2]} | ${HS.map((h) => { const r = B[key(u, hk(h), b, e)]; if (!r) return '-'; if (r.timeout) return '>900 s';
    return `${f(r.sm)}[${f(r.sx, 0)}] · ${f(r.cap / 1000, 1)}k/${f(r.capW / 1000, 1)}k · ${f(100 * r.valid)}% (${f(100 * r.fab)}%)${u ? ` · 긴급 ${f(100 * r.urg)}%` : ''} · J ${f(r.jain, 3)}`; }).join(' | ')} |`);
}
console.log('\n### custom 정렬 지연 평균 ms (1 s 마감 위반 %) — 긴급 끔, 배치 10000');
console.log('| 혼잡 | ε | 1k | 2k | 5k | 10k | 20k TPS |\n|---|---|---|---|---|---|---|');
for (const h of HS) for (const e of EPS) { const t = T[key(false, hk(h), 10000, e)]; if (t) console.log(`| ${h[2]} | ${e[2]} | ${t.map((x) => `${f(x.om, 0)}${x.miss > 0 ? ` (${f(100 * x.miss, 0)}%)` : ''}`).join(' | ')} |`); }

// ---- 그림 C1: 맞교환 — 가로 따라갈 수 있는 TPS(로그, 오른쪽이 좋다), 세로 살린 비율. 점 = ε, 선 = 혼잡 ----
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const Tx = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
const HC = { '0.20/0.10': '#2563eb', '0.40/0.20': '#d97706', '0.60/0.30': '#dc2626' };
{
  const W = 1100, H = 460; let body = '';
  [1000, 5000, 10000].forEach((b, j) => {
    const x0 = 80 + j * 345, y0 = 370, w = 270, h = 280, lo = 1000, hi = 200000;
    const xm = (v) => x0 + (Math.log10(Math.max(lo, Math.min(hi, v))) - 3) / (Math.log10(hi) - 3) * w;
    const ym = (v) => y0 - v * h;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) body += `<line x1="${x0}" y1="${ym(t)}" x2="${x0 + w}" y2="${ym(t)}" stroke="#e5e7eb"/>` + Tx(x0 - 6, ym(t) + 4, `${t * 100}%`, 'text-anchor="end" font-size="11"');
    for (const t of [1000, 10000, 100000]) body += `<line x1="${xm(t)}" y1="${y0}" x2="${xm(t)}" y2="${y0 - h}" stroke="#f1f5f9"/>` + Tx(xm(t), y0 + 16, `${t / 1000}k`, 'text-anchor="middle" font-size="11"');
    body += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
    body += Tx(x0 + w / 2, y0 - h - 12, `배치 ${b}`, 'text-anchor="middle" font-weight="bold" font-size="13"');
    body += Tx(x0 + w / 2, y0 + 34, '따라갈 수 있는 최대 TPS (로그, 평균 정렬 기준)', 'text-anchor="middle" fill="#444" font-size="11"');
    if (j === 0) body += Tx(x0 - 46, y0 - h / 2, '배치 안 살린 비율', `text-anchor="middle" transform="rotate(-90 ${x0 - 46} ${y0 - h / 2})"`);
    for (const hh of HS) {
      const hkey = hk(hh), pts = EPS.map((e) => [e, B[key(false, hkey, b, e)]]).filter(([, r]) => r && !r.timeout);
      if (!pts.length) continue;
      body += `<polyline points="${pts.map(([, r]) => `${xm(r.cap)},${ym(r.valid)}`).join(' ')}" fill="none" stroke="${HC[hkey]}" stroke-width="2.2"/>`;
      for (const [e, r] of pts) body += `<circle cx="${xm(r.cap)}" cy="${ym(r.valid)}" r="4" fill="${HC[hkey]}"/>` + Tx(xm(r.cap) + 6, ym(r.valid) - 6, e[2], `font-size="9.5" fill="${HC[hkey]}"`);
      const fab = pts[0][1].fab; body += `<line x1="${x0}" y1="${ym(fab)}" x2="${x0 + w}" y2="${ym(fab)}" stroke="${HC[hkey]}" stroke-dasharray="3 3" stroke-opacity="0.6"/>`;
    }
    body += `<line x1="${xm(4000)}" y1="${y0}" x2="${xm(4000)}" y2="${y0 - h}" stroke="#111" stroke-dasharray="5 3" stroke-opacity="0.5"/>`;
  });
  body += Tx(W / 2, 34, 'custom 부하: ε를 키우면 더 살리지만(위로) 따라갈 수 있는 TPS가 준다(왼쪽으로). 점 옆 숫자 = ε, 점선(가로) = 도착 순서 그대로(Fabric), 점선(세로) = 4k TPS', 'text-anchor="middle" font-weight="bold" font-size="12.5"');
  body += HS.map((hh, i) => `<line x1="${330 + i * 150}" y1="56" x2="${348 + i * 150}" y2="56" stroke="${HC[hk(hh)]}" stroke-width="2.5"/>` + Tx(352 + i * 150, 60, `인기 키 ${hh[2]}`)).join('');
  body += Tx(W / 2, H - 12, 'custom 합성(키 10000, 인기 키 100, tx 당 읽기 4·쓰기 4, 인기 키 확률 hr/hw), 긴급 끔, 경로 비용 10 ms + 0.02 ms/tx, 조건마다 배치 20개(10000 은 12개) 실제 정렬', 'text-anchor="middle" fill="#555" font-size="11"');
  fs.writeFileSync(path.join(OUT, 'figC1-tradeoff.svg'), svg(W, H, body));
}
