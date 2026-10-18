// §86 실험 2·1 요약
//   node exp21.js <results 폴더> <res-*.txt 폴더>
// 실험 2: 실행(meta.start~end) 동안의 컨테이너 CPU 초와 org1 피어 원장 증가량을, 그 실행의 성공 tx 수(tally 전체)로 나눈다.
// 실험 1: User2 만 Zipf s 2.5. 사용자별 쓰기 성공률, Jain, User2 / 나머지 평균.
const fs = require('fs'), path = require('path');
const R = process.argv[2] || path.join(__dirname, '../zipfbench/results');
const S = process.argv[3] || R;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
const fmt = (a, d = 1) => a.length ? `${mean(a).toFixed(d)}${a.length > 1 ? ` ± ${sd(a).toFixed(d)}` : ''}` : '-';
const USERS = ['User1', 'User2', 'User3', 'User4', 'User5'];
function tally(d, steady) {
  const a = {}, uw = {};
  for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f))), t = steady ? j.tallySteady : j.tally;
    for (const [k, x] of Object.entries(t.all)) a[k] = (a[k] || 0) + x;
    const w = uw[j.user] || (uw[j.user] = { tot: 0, ok: 0 });
    for (const kind of ['normalWrite', 'urgent']) if (t[kind]) { w.tot += t[kind].total; w.ok += t[kind].success; }
  }
  return { a, uw };
}
console.log('### 실험 2. 성공 tx 당 자원 (실행 전체 기준, 2회 평균)');
console.log('| 부하 | 시스템 | 성공/s(정상 구간) | 피어 CPU ms / 성공 tx (org1+org2) | 오더러 CPU ms / 성공 | 원장 증가 KB / 성공 tx | 원장에 저장된 무효 tx 비율 |');
console.log('|---|---|---|---|---|---|---|');
const sysOf = { A1: 'A1', FPP: 'FPP', HTF: 'HTF', BE075: 'BE' };
for (const mode of ['smallbank', 'custom']) for (const lab of ['A1', 'FPP', 'HTF', 'BE075']) {
  const v = { sp: [], peer: [], ord: [], led: [], inv: [] };
  for (const rep of [1, 2]) {
    const d = path.join(R, `res-${mode}-${lab}`, sysOf[lab], 'u0', `rep${rep}`), sf = path.join(S, `res-${mode}-${lab}-rep${rep}.txt`);
    if (!fs.existsSync(path.join(d, 'meta.json')) || !fs.existsSync(sf)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), t0 = Date.parse(meta.start), t1 = Date.parse(meta.end);
    const smp = fs.readFileSync(sf, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)).filter((r) => r[1] > 0);
    const at = (t) => smp.reduce((best, r) => Math.abs(r[0] - t) < Math.abs(best[0] - t) ? r : best, smp[0]);
    const s0 = at(t0), s1 = at(t1);
    const all = tally(d, false), st = tally(d, true), dur = meta.duration - (meta.warmupSec || 0);
    const succ = all.a.success, fail = all.a.failFast + all.a.failSlow; // 블록에 들어간 무효 = 피어 무효(시간 초과 포함)
    v.sp.push(st.a.success / dur);
    v.peer.push(((s1[1] - s0[1]) + (s1[2] - s0[2])) / 1000 / succ);
    v.ord.push((s1[3] - s0[3]) / 1000 / succ);
    v.led.push((s1[5] - s0[5]) / 1024 / succ);
    v.inv.push(100 * fail / (succ + fail));
  }
  if (v.sp.length) console.log(`| ${mode} | ${lab} | ${fmt(v.sp, 0)} | ${fmt(v.peer, 2)} | ${fmt(v.ord, 3)} | ${fmt(v.led, 2)} | ${fmt(v.inv)}% |`);
}
console.log('\n### 실험 1. User2 만 인기 계좌에 몰림(s 2.5, 나머지 1.0), smallbank, 3회');
console.log('| 시스템 | 성공/s | User2 쓰기 성공률 | 나머지 4명 평균 | User2 / 나머지 | Jain(5명) | U1 · U3 · U4 · U5 |');
console.log('|---|---|---|---|---|---|---|');
for (const [lab, sys] of [['A1', 'A1'], ['FPP', 'FPP'], ['HTF', 'HTF'], ['BE-a0', 'BE'], ['BE-a1', 'BE'], ['BE-a3', 'BE']]) {
  const base = path.join(R, `skew-${lab}`, sys, 'u0'); if (!fs.existsSync(base)) continue;
  const v = { sp: [], u2: [], rest: [], ratio: [], jain: [], per: [] };
  for (const rep of fs.readdirSync(base)) {
    const d = path.join(base, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), dur = meta.duration - (meta.warmupSec || 0);
    const { a, uw } = tally(d, true), r = (u) => uw[u].ok / uw[u].tot;
    const xs = USERS.map(r), rest = mean(['User1', 'User3', 'User4', 'User5'].map(r));
    v.sp.push(a.success / dur); v.u2.push(100 * r('User2')); v.rest.push(100 * rest); v.ratio.push(r('User2') / rest);
    v.jain.push(xs.reduce((p, c) => p + c, 0) ** 2 / (5 * xs.reduce((p, c) => p + c * c, 0))); v.per.push(xs);
  }
  if (!v.sp.length) continue;
  const per = [0, 2, 3, 4].map((i) => (100 * mean(v.per.map((x) => x[i]))).toFixed(0)).join(' · ');
  console.log(`| ${lab} | ${fmt(v.sp, 0)} | ${fmt(v.u2)}% | ${fmt(v.rest)}% | ${fmt(v.ratio, 2)} | ${fmt(v.jain, 3)} | ${per}% |`);
}
