// §81 빈칸 채우기 요약: results/gapA-*, gapB-*, gapC-* (+ §70·§71 의 rep1: ht30-t4000-b1000, b5000-BE)
//   node gapfill.js [results 폴더]
const fs = require('fs'), path = require('path');
const R = process.argv[2] || path.join(__dirname, '../zipfbench/results');
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
function runs(dirs) {
  const out = [];
  for (const base of dirs) {
    if (!fs.existsSync(base)) continue;
    for (const rep of fs.readdirSync(base)) {
      const d = path.join(base, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
      const users = fs.readdirSync(d).filter((f) => f.startsWith('user-')); if (!users.length) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), dur = meta.duration - (meta.warmupSec || 0), b = +meta.batchSize;
      const a = {}, u = {};
      for (const f of users) { const t = JSON.parse(fs.readFileSync(path.join(d, f))).tallySteady;
        for (const [k, x] of Object.entries(t.all)) a[k] = (a[k] || 0) + x;
        for (const [k, x] of Object.entries(t.urgent || {})) u[k] = (u[k] || 0) + x; }
      const pl = fs.existsSync(path.join(d, 'processor.log')) ? fs.readFileSync(path.join(d, 'processor.log'), 'utf8').split('\n') : [];
      const bt = pl.map((l) => l.match(/\[Batch\] n=(\d+) ordered=(\d+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
      const tm = pl.map((l) => l.match(/\[Timing\] n=(\d+).*sched=([\d.]+)/)).filter(Boolean).filter((m) => +m[1] >= b * 0.9);
      out.push({ sent: a.total / dur, sp: a.success / dur, rate: 100 * a.success / a.total, lat: a.latencySuccessSum / a.success,
        slow: a.failSlow, inb: 100 * mean(bt.map((m) => +m[2] / +m[1])), sch: mean(tm.map((m) => +m[2])),
        urg: u.total ? 100 * u.success / u.total : NaN, urgLat: u.success ? u.latencySuccessSum / u.success : NaN });
    }
  }
  return out;
}
const f = (rs, k, d = 1) => rs.length ? `${mean(rs.map((r) => r[k])).toFixed(d)}${rs.length > 1 ? ` ± ${sd(rs.map((r) => r[k])).toFixed(d)}` : ''}` : '-';
const dir = (n, sys = 'BE') => path.join(R, n, sys, 'u0');

console.log('### A. 경계 TPS (custom, 배치 1000, 긴급 끔) — 성공/s · 커밋 지연 ms (회수)');
console.log('| TPS | ε 0 | ε 0.5 | ε 1 |\n|---|---|---|---|');
const prev = { 1000: 'epsc-e{e}-t1000-b1000', 3000: 'epsc-e{e}-t3000-b1000' };
for (const t of [1000, 1500, 2000, 2500, 3000]) {
  const cells = ['0', '0.5', '1'].map((e) => {
    const name = prev[t] ? prev[t].replace('{e}', e) : `gapA-e${e}-t${t}`;
    const rs = runs([dir(name)]); if (!rs.length) return '-';
    return `${f(rs, 'sp', 0)} · ${f(rs, 'lat', 0)} ms (${rs.length})`;
  });
  console.log(`| ${t}${prev[t] ? ' (§77)' : ''} | ${cells.join(' | ')} |`);
}
console.log('\n### B. 긴급 ε (custom, 배치 1000, 긴급 1, 1000 TPS, ε_low 0.75)');
console.log('| ε_urgent | 긴급 tx 성공률 | 긴급 커밋 지연 | 전체 성공/s | 전체 성공률 | 정렬 ms |\n|---|---|---|---|---|---|');
for (const eu of ['0.1', '1']) { const rs = runs([dir(`gapB-eu${eu}`)]); console.log(`| ${eu} | ${f(rs, 'urg')}% | ${f(rs, 'urgLat', 0)} ms | ${f(rs, 'sp', 0)} | ${f(rs, 'rate')}% | ${f(rs, 'sch', 2)} |`); }
console.log('\n### C. 고부하 반복 (smallbank s 1.0, BE)');
console.log('| TPS | 배치 | 회 | 보낸 TPS | 성공/s | 커밋 지연 | 시간 초과 |\n|---|---|---|---|---|---|---|');
for (const [t, b, extra] of [[3000, 100], [3000, 1000], [4000, 1000, 'ht30-t4000-b1000'], [4000, 5000, 'b5000-BE']]) {
  const rs = runs([dir(`gapC-t${t}-b${b}`), ...(extra ? [dir(extra)] : [])]);
  console.log(`| ${t} | ${b} | ${rs.length} | ${f(rs, 'sent', 0)} | ${f(rs, 'sp', 0)} | ${f(rs, 'lat', 0)} ms | ${f(rs, 'slow', 0)} |`);
}
