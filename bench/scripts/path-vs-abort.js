// 배치별 commit→블록 커밋 시간을 버린 수 구간별로 평균 (aggregate-path.js 의 짝 맞추기 재사용)
const fs = require('fs'), path = require('path');
const roots = process.argv.slice(2);
const bins = {};
for (const root of roots) for (const sys of ['FPP', 'BE', 'HTF']) {
  const sd = path.join(root, sys); if (!fs.existsSync(sd)) continue;
  for (const u of fs.readdirSync(sd)) for (const rep of fs.readdirSync(path.join(sd, u))) {
    const dir = path.join(sd, u, rep);
    const L = fs.readFileSync(path.join(dir, 'processor.log'), 'utf8').split('\n');
    const bs = []; let p = null;
    for (const l of L) {
      let m = l.match(/\[Batch\] n=(\d+) ordered=(\d+) aborted=(\d+)/); if (m) { p = { n: +m[1], ordered: +m[2], ab: +m[3] }; continue; }
      m = l.match(/\[Timing\].*create=(\d+) recv=(\d+) decode=([\d.]+) meta=([\d.]+) load=([\d.]+) sched=([\d.]+) save=([\d.]+) encode=([\d.]+)/);
      if (m && p) { const s = +m[3] + +m[4] + +m[5] + +m[6] + +m[7] + +m[8]; bs.push({ ...p, done: +m[2] + s }); p = null; }
    }
    const bl = [];
    for (const l of fs.readFileSync(path.join(dir, 'peer-commits.log'), 'utf8').split('\n')) {
      const m = l.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) UTC .*Committed block \[(\d+)\] with (\d+) tx/) || l.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) UTC .*Committed block \[(\d+)\] with (\d+) transaction/);
      if (m) bl.push({ t: Date.parse(m[1].replace(' ', 'T') + 'Z'), txs: +m[3] });
    }
    const B = bs.filter(b => b.n >= 10), k = Math.min(B.length, bl.length);
    const b2 = B.slice(B.length - k), l2 = bl.slice(bl.length - k);
    if (b2.filter((b, i) => b.ordered !== l2[i].txs).length > k * 0.05) continue;
    b2.forEach((b, i) => {
      const bin = sys + ' ' + (b.ab === 0 ? '0' : b.ab < 15 ? '1-14' : b.ab < 30 ? '15-29' : b.ab < 45 ? '30-44' : '45+');
      (bins[bin] = bins[bin] || []).push(l2[i].t - b.done);
    });
  }
}
for (const k of Object.keys(bins).sort()) { const v = bins[k].sort((a, b) => a - b); console.log(k.padEnd(10), 'batches', String(v.length).padStart(4), 'mean', (v.reduce((a, b) => a + b, 0) / v.length).toFixed(0), 'median', v[v.length >> 1]); }
