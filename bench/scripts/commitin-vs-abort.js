// commit→오더러 수신 시간을 배치의 버린 수 구간별로 (path-smallbank)
const fs = require('fs'), path = require('path');
const root = process.argv[2], bins = {};
for (const sys of fs.readdirSync(root)) for (const rep of ['rep1', 'rep2']) {
  const dir = path.join(root, sys, 'u0', rep); if (!fs.existsSync(path.join(dir, 'processor.log'))) continue;
  const bs = []; let p = null;
  for (const l of fs.readFileSync(path.join(dir, 'processor.log'), 'utf8').split('\n')) {
    let m = l.match(/\[Batch\] n=(\d+) ordered=(\d+) aborted=(\d+)/); if (m) { p = { n: +m[1], ordered: +m[2], ab: +m[3] }; continue; }
    m = l.match(/\[Timing\].*create=(\d+) recv=(\d+) decode=([\d.]+) meta=([\d.]+) load=([\d.]+) sched=([\d.]+) save=([\d.]+) encode=([\d.]+)/);
    if (m && p) { bs.push({ ...p, done: +m[2] + [3, 4, 5, 6, 7, 8].reduce((a, i) => a + +m[i], 0) }); p = null; }
  }
  const cs = [];
  for (const l of fs.readFileSync(path.join(dir, 'orderer.log'), 'utf8').split('\n')) {
    const m = l.match(/\[COMMITDATA\] id=\S* order=(\d+)/); if (m) cs.push({ t: Date.parse(l.slice(0, 23) + 'Z'), order: +m[1] });
  }
  // 순서대로 걸으며 ordered==order 이고 시간이 맞는(0~1000ms) 짝을 찾는다
  let j = 0;
  for (const b of bs) {
    while (j < cs.length && cs[j].t < b.done - 5) j++;
    if (j < cs.length && cs[j].order === b.ordered && cs[j].t - b.done < 1000) {
      const bin = sys + ' ' + (b.ab === 0 ? '0' : b.ab < 15 ? '01-14' : b.ab < 30 ? '15-29' : b.ab < 45 ? '30-44' : '45+');
      (bins[bin] = bins[bin] || []).push(cs[j].t - b.done); j++;
    }
  }
}
for (const k of Object.keys(bins).sort()) { const v = bins[k].sort((a, b) => a - b); console.log(k.padEnd(10), 'n', String(v.length).padStart(3), 'mean', (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), 'p50', v[v.length >> 1].toFixed(1), 'p90', v[Math.floor(v.length * 0.9)].toFixed(1)); }
