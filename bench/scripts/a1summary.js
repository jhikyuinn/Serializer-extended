// §42 A-1: s 별(또는 부하별) 시스템 비교. 성공/s, 성공률, 커밋 지연, 실패 통보까지 포함한 평균 지연, 블록 왕복 구간
const fs = require('fs'), path = require('path');
const { loadUsers } = require('../zipfbench/users-lib');
const R = path.join(__dirname, '../zipfbench/results');
const mode = process.argv[2] || 's'; // s | load
const m = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
const pre = mode === 's' ? ['a1-s', 'a1e11-s'] : mode === 'load2' ? ['load2-t', 'load2e11-t'] : ['a2load-t', 'a2loade11-t'];
const keys = [...new Set(fs.readdirSync(R).filter((d) => d.startsWith(pre[0])).map((d) => d.slice(pre[0].length)))].sort((a, b) => a - b);
const rows = [];
for (const k of keys) {
  for (const [p, sysList] of [[pre[0], [['A1', 'Fabric(같은 소스)'], ['A2', 'Fabric 2.5.10'], ['BE', 'Serializer ε.1/.75']]], [pre[1], [['BE', 'Serializer ε1/1']]]]) {
    for (const [sys, label] of sysList) {
      const d = path.join(R, p + k, sys, 'u0'); if (!fs.existsSync(d)) continue;
      const succ = [], rate = [], lat = [], latAll = [], sent = [];
      for (const rep of fs.readdirSync(d)) {
        const mf = path.join(d, rep, 'meta.json'); if (!fs.existsSync(mf)) continue;
        const meta = JSON.parse(fs.readFileSync(mf)); const us = loadUsers(path.join(d, rep)); if (!us.length) continue;
        const a = us.reduce((o, u) => { for (const [kk, v] of Object.entries(u.tally.all)) o[kk] = (o[kk] || 0) + v; return o; }, {});
        succ.push(a.success / meta.duration); rate.push(a.success / a.total); sent.push(a.total / meta.duration);
        lat.push(a.latencySuccessSum / a.success);
        latAll.push((a.latencySuccessSum + (a.latencyFailSum || 0)) / a.total);
      }
      if (!succ.length) continue;
      rows.push(`| ${k} | ${label} | ${succ.length} | ${m(succ).toFixed(1)} ± ${sd(succ).toFixed(1)} | ${(100 * m(rate)).toFixed(1)}% | ${m(lat).toFixed(0)} ± ${sd(lat).toFixed(0)} | ${m(latAll).toFixed(0)} | ${m(sent).toFixed(0)} |`);
    }
  }
}
console.log(`| ${mode === 's' ? 's' : 'TPS'} | 시스템 | 회 | 성공/s (± sd) | 성공률 | 커밋 지연 ms (± sd) | 결과 받기까지 평균 (성공+실패) | 보낸 tx/s |\n|---|---|---|---|---|---|---|---|`);
console.log(rows.join('\n'));
