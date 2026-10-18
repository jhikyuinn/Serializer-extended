// §54 클라우드 본 실험 요약: (s, 배치, 시스템)마다 3회 평균 ± 표준편차. 정상 구간(앞 5초 제외, tallySteady) 기준
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '../zipfbench/results/cloud');
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
const out = [];
for (const b of [100, 500, 1000]) for (const s of ['0', '0.5', '1.0', '1.5', '2.0']) {
  const row = { s, b };
  for (const sys of ['A1', 'BE']) {
    const d = path.join(R, `cloud-s${s}-b${b}`, sys, 'u0');
    const v = { sent: [], sp: [], rate: [], q: [], lat: [], all: [], ab: [], dev: [], sort: [], blk: [] };
    for (const rep of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const dir = path.join(d, rep); if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
      const users = {}; const a = {}; const q = [0, 0];
      for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('user-'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f))); const t = j.tallySteady;
        for (const [k, x] of Object.entries(t.all)) a[k] = (a[k] || 0) + x;
        q[0] += t.query.success; q[1] += t.query.total; users[j.user] = (users[j.user] || 0) + t.all.success / dur;
      }
      const per = Object.values(users);
      v.sent.push(a.total / dur); v.sp.push(a.success / dur); v.rate.push(100 * a.success / a.total); v.q.push(100 * q[0] / q[1]);
      v.lat.push(a.latencySuccessSum / a.success); v.all.push((a.latencySuccessSum + a.latencyFailSum) / a.total);
      if (a.failNotified) v.ab.push(a.latencyNotifiedSum / a.failNotified);
      v.dev.push(Math.sqrt(m(per.map((p) => (p - m(per)) ** 2))));
      const pl = path.join(dir, 'processor.log');
      if (fs.existsSync(pl)) { const so = fs.readFileSync(pl, 'utf8').split('\n').map((l) => l.match(/sched=([\d.]+)/)).filter(Boolean).map((x) => +x[1]); if (so.length) v.sort.push(m(so)); }
      const pc = fs.readFileSync(path.join(dir, 'peer-commits.log'), 'utf8').split('\n').map((l) => l.match(/with (\d+) transaction/)).filter(Boolean).map((x) => +x[1]).filter((x) => x >= 10);
      if (pc.length) v.blk.push(m(pc));
    }
    row[sys] = Object.fromEntries(Object.entries(v).map(([k, a]) => [k, a.length ? [m(a), sd(a), a.length] : null]));
  }
  out.push(row);
}
fs.writeFileSync(path.join(R, 'cloud-summary.json'), JSON.stringify(out, null, 1));
const f = (x, d = 1) => x ? `${x[0].toFixed(d)} ± ${x[1].toFixed(d)}` : '-';
console.log('| s | 배치 | Fabric 성공/s | Serializer 성공/s | 배율 | 성공률 F / S | Query 성공률 F / S | Serializer 받은 TPS | 결과까지 평균 지연 F → S (ms) | 커밋 지연 F → S | abort 통보 | 사용자 간 sd F / S | 블록 tx F / S | 정렬 ms |');
console.log('|' + '---|'.repeat(14));
for (const r of out) {
  const A = r.A1, B = r.BE;
  console.log(`| ${r.s} | ${r.b} | ${f(A.sp)} | ${f(B.sp)} | ${(B.sp[0] / A.sp[0]).toFixed(2)}× | ${A.rate[0].toFixed(1)}% / ${B.rate[0].toFixed(1)}% | ${A.q[0].toFixed(1)}% / ${B.q[0].toFixed(1)}% | ${f(B.sent, 0)} | ${A.all[0].toFixed(0)} → ${B.all[0].toFixed(0)} | ${A.lat[0].toFixed(0)} → ${B.lat[0].toFixed(0)} | ${B.ab ? B.ab[0].toFixed(0) : '-'} | ${A.dev[0].toFixed(1)} / ${B.dev[0].toFixed(1)} | ${A.blk ? A.blk[0].toFixed(0) : '-'} / ${B.blk ? B.blk[0].toFixed(0) : '-'} | ${B.sort ? B.sort[0].toFixed(2) : '-'} |`);
}
