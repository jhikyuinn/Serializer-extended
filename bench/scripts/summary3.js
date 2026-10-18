// 재실험(§39) 요약: 묶음 × 시스템 × 긴급 → 성공/s 평균±반복 표준편차, Query·긴급 성공률, 커밋·abort 통보 지연, 사용자 간 표준편차
const fs = require('fs'), path = require('path');
const { loadUsers } = require('../zipfbench/users-lib');
const R = '../zipfbench/results/';
const sets = process.argv.slice(2);
const LABEL = { A2: 'Fabric', FPP: 'Fabric++', HTF: 'HTFabric', BE: 'Serializer' };
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
for (const set of sets) {
  console.log(`\n### ${set}\n\n| 시스템 | 긴급 | 성공/s (±반복 sd) | 사용자 간 sd | Query 성공률 | 긴급 성공률 | 다른 사용자 쓰기 | 커밋 지연 | abort 통보 지연 |\n|---|---|---|---|---|---|---|---|---|`);
  for (const sys of ['A2', 'FPP', 'HTF', 'BE']) for (const u of ['u0', 'u1']) {
    const d = path.join(R, set, sys, u); if (!fs.existsSync(d)) continue;
    const tot = [], dev = []; const acc = {};
    const add = (k, v) => acc[k] = (acc[k] || 0) + (v || 0);
    for (const rep of fs.readdirSync(d)) {
      const meta = JSON.parse(fs.readFileSync(path.join(d, rep, 'meta.json')));
      const us = loadUsers(path.join(d, rep)); const per = us.map((x) => x.tally.all.success / meta.duration);
      tot.push(per.reduce((a, b) => a + b, 0)); dev.push(Math.sqrt(m(per.map((p) => (p - m(per)) ** 2))));
      for (const x of us) {
        const t = x.tally;
        add('qs', t.query.success); add('qt', t.query.total); add('us', t.urgent.success); add('ut', t.urgent.total);
        if (x.user !== 'User3') { add('ws', t.normalWrite.success); add('wt', t.normalWrite.total); }
        add('ls', t.all.latencySuccessSum); add('s', t.all.success); add('ln', t.all.latencyNotifiedSum); add('n', t.all.failNotified);
      }
    }
    const p = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
    console.log(`| ${LABEL[sys]} | ${u.slice(1)} | ${m(tot).toFixed(1)} ± ${sd(tot).toFixed(1)} | ${m(dev).toFixed(2)} | ${p(acc.qs, acc.qt)} | ${p(acc.us, acc.ut)} | ${p(acc.ws, acc.wt)} | ${(acc.ls / acc.s).toFixed(0)} | ${acc.n ? (acc.ln / acc.n).toFixed(0) : '-'} |`);
  }
}
