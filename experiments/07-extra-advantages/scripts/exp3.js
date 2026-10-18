// 실험 3(NOTES §86): 실패를 알게 되기까지 걸리는 시간. 실험 4(fair-*) 의 tx 로그를 다시 읽는다.
//   node exp3.js <results 폴더>
// tx-<사용자>-w<i>.json 한 줄 = [보낸 시각, 종류(n/u/q), 결과(s 성공 / a abort 통보 / f 피어 무효 / t 시간 초과), 걸린 ms]
const fs = require('fs'), path = require('path');
const R = process.argv[2] || path.join(__dirname, '../../../bench/zipfbench/results');
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const out = {};
console.log('| 부하 | 시스템 | 실패 tx | 실패를 알기까지 평균 ms | 미리 통보(a) 비율 | a 평균 ms | f 평균 ms | t 비율 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const mode of ['smallbank', 'custom']) for (const [lab, sys] of [['A1', 'A1'], ['FPP', 'FPP'], ['HTF', 'HTF'], ['BE075', 'BE']]) {
  const by = { a: [], f: [], t: [] };
  const base = path.join(R, `fair-${mode}-${lab}`, sys, 'u0');
  if (!fs.existsSync(base)) continue;
  for (const rep of fs.readdirSync(base)) for (const f of fs.readdirSync(path.join(base, rep)).filter((f) => /^tx-.*\.json$/.test(f)))
    for (const [, kind, r, ms] of JSON.parse(fs.readFileSync(path.join(base, rep, f)))) if (kind !== 'q' && by[r]) by[r].push(ms);
  const all = [...by.a, ...by.f, ...by.t];
  out[`${mode}-${lab}`] = { n: all.length, mean: mean(all), aShare: by.a.length / all.length, a: mean(by.a), f: mean(by.f), tShare: by.t.length / all.length };
  const o = out[`${mode}-${lab}`];
  console.log(`| ${mode} | ${lab} | ${o.n} | ${o.mean.toFixed(0)} | ${(o.aShare * 100).toFixed(1)}% | ${by.a.length ? o.a.toFixed(0) : '-'} | ${o.f.toFixed(0)} | ${(o.tShare * 100).toFixed(1)}% |`);
}
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
