// §50 배치 크기 실험 요약: (배치, TPS, 시스템)마다 3회 평균 ± 표준편차
const fs = require('fs'), path = require('path');
const { loadUsers } = require('../zipfbench/users-lib');
const R = path.join(__dirname, '../zipfbench/results');
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
const f = (a, d = 1) => `${m(a).toFixed(d)} ± ${sd(a).toFixed(d)}`;
console.log('| 배치 | TPS | 시스템 | 회 | 성공/s | 성공률 | Query 성공률 | 커밋 지연 ms | 결과까지 평균 ms | abort 통보 ms | 사용자 간 sd | 블록 tx | 정렬 ms/배치 |');
console.log('|' + '---|'.repeat(13));
for (const b of [100, 500, 1000]) for (const t of [250, 350]) for (const [s, label] of [['A1', 'Fabric(같은 소스)'], ['BE', 'Serializer']]) {
  const d = path.join(R, `batch-b${b}-t${t}`, s, 'u0'); if (!fs.existsSync(d)) continue;
  const v = { sp: [], rate: [], q: [], lat: [], all: [], ab: [], dev: [], blk: [], sort: [] };
  for (const rep of fs.readdirSync(d)) {
    const dir = path.join(d, rep); const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
    const us = loadUsers(dir); const a = {}; for (const u of us) for (const [k, x] of Object.entries(u.tally.all)) a[k] = (a[k] || 0) + x;
    const q = us.reduce((o, u) => [o[0] + u.tally.query.success, o[1] + u.tally.query.total], [0, 0]);
    const per = us.map((u) => u.tally.all.success / meta.duration);
    v.sp.push(a.success / meta.duration); v.rate.push(100 * a.success / a.total); v.q.push(100 * q[0] / q[1]);
    v.lat.push(a.latencySuccessSum / a.success); v.all.push((a.latencySuccessSum + a.latencyFailSum) / a.total);
    if (a.failNotified) v.ab.push(a.latencyNotifiedSum / a.failNotified);
    v.dev.push(Math.sqrt(m(per.map((p) => (p - m(per)) ** 2))));
    const pc = fs.readFileSync(path.join(dir, 'peer-commits.log'), 'utf8').split('\n').map((l) => l.match(/with (\d+) transaction/)).filter(Boolean).map((x) => +x[1]).filter((x) => x >= 10);
    if (pc.length) v.blk.push(m(pc));
    const pl = path.join(dir, 'processor.log');
    if (fs.existsSync(pl)) { const so = fs.readFileSync(pl, 'utf8').split('\n').map((l) => l.match(/sched=([\d.]+)/)).filter(Boolean).map((x) => +x[1]); if (so.length) v.sort.push(m(so)); }
  }
  const o = (a, d) => a.length ? f(a, d) : '-';
  console.log(`| ${b} | ${t} | ${label} | ${v.sp.length} | ${o(v.sp, 1)} | ${o(v.rate, 1)}% | ${o(v.q, 1)}% | ${o(v.lat, 0)} | ${o(v.all, 0)} | ${o(v.ab, 0)} | ${o(v.dev, 2)} | ${o(v.blk, 0)} | ${o(v.sort, 2)} |`);
}
