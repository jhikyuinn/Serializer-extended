// §77 ε 클라우드 확인 요약: results/epsc-e<ε>-t<TPS>-b<B>/BE/u0/rep<n>
//   node epscheck.js [results 폴더]
// 비교: 시뮬레이션(§75, custom 0.2/0.1, 긴급 끔) 배치 안 살린 비율과 정렬 시간
const fs = require('fs'), path = require('path');
const R = process.argv[2] || path.join(__dirname, '../../../bench/zipfbench/results');
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
const num = (s, k) => { const m = s.match(new RegExp(`\\b${k}=([\\d.]+)`)); return m ? +m[1] : NaN; };
const SIM = { '0-1000': [44.5, 0.3], '1-1000': [79.8, 6.0], '0-10000': [13.8, 2.1], '1-10000': [18.6, 880] };
console.log('| ε | 배치 | TPS | 회 | 보낸 TPS | 성공/s | 성공률 | 배치 안 살린 비율 (시뮬) | 커밋 지연 | 통보/피어무효/시간초과 /s | 정렬 ms 평균[최대] (시뮬) | Kafka 왕복 ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const b of [1000, 10000]) for (const e of ['0', '1']) for (const t of [1000, 2000, 3000]) {
  const base = path.join(R, `epsc-e${e}-t${t}-b${b}`, 'BE', 'u0');
  if (!fs.existsSync(base)) continue;
  const v = { sent: [], sp: [], rate: [], lat: [], n: [], f: [], s: [], inb: [], sch: [], schx: [], wait: [] };
  for (const rep of fs.readdirSync(base)) {
    const d = path.join(base, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
    const a = {};
    for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-')))
      for (const [k, x] of Object.entries(JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady.all)) a[k] = (a[k] || 0) + x;
    v.sent.push(a.total / dur); v.sp.push(a.success / dur); v.rate.push(100 * a.success / a.total); v.lat.push(a.latencySuccessSum / a.success);
    v.n.push(a.failNotified / dur); v.f.push(a.failFast / dur); v.s.push(a.failSlow / dur);
    const pl = fs.readFileSync(path.join(d, 'processor.log'), 'utf8').split('\n');
    const tm = pl.map((l) => l.match(/\[Timing\] n=(\d+).*sched=([\d.]+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
    if (tm.length) { v.sch.push(mean(tm.map((m) => +m[2]))); v.schx.push(Math.max(...tm.map((m) => +m[2]))); }
    const bt = pl.map((l) => l.match(/\[Batch\] n=(\d+) ordered=(\d+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
    if (bt.length) v.inb.push(100 * mean(bt.map((m) => +m[2] / +m[1])));
    const ol = fs.readFileSync(path.join(d, 'orderer.log'), 'utf8').split('\n').filter((l) => l.includes('[ORDBATCH]')).filter((l) => num(l, 'n') >= b * 0.9);
    if (ol.length) v.wait.push(mean(ol.map((l) => num(l, 'wait'))));
  }
  const f = (a, d = 1) => `${mean(a).toFixed(d)}${a.length > 1 ? ` ± ${sd(a).toFixed(d)}` : ''}`;
  const sim = SIM[`${e}-${b}`];
  console.log(`| ${e} | ${b} | ${t} | ${v.sp.length} | ${f(v.sent, 0)} | ${f(v.sp)} | ${f(v.rate)}% | ${f(v.inb)}% (${sim[0]}%) | ${f(v.lat, 0)} ms | ${mean(v.n).toFixed(0)}/${mean(v.f).toFixed(0)}/${mean(v.s).toFixed(0)} | ${f(v.sch, 1)}[${Math.max(...v.schx).toFixed(0)}] (${sim[1]}) | ${f(v.wait, 1)} |`);
}
