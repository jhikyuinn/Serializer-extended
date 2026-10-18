// §87 합의 성공률 시뮬레이션: 예전 설계(2026-10-13 보정)와 §48 설계(지금)를 같은 격자로 계산한다.
//   node sim87.js <mttr run.log> [출력 json]
// 격자: s-node replica 1~5 × pod 장애 확률 1/5/10/15% × (Byzantine 3/10 포함, pod 장애만), 500라운드, 마감 10초.
// 지금 설계의 값
//   Lease 인계: mttr run.log 의 SIGSTOP 실측 takeover(최소~최대)에서 failoverReady 0.3초를 뺀 범위
//   인계 직후 커미티: 유예 grace 3초 + committee (§48 ②)
//   정상 커미티 구성: committee 0.35초 (모두 등록 → 0.3초 조용 → 생성, §48 ①). 실측 아니라 설계값이라 1.0초도 함께 계산한다
//   w-node 재접속: 1~2초 (1초마다 확인·재접속, §48)
const fs = require('fs');
const { C, experiment } = require('./simulate');
const LOG = process.argv[2], OUT = process.argv[3];
const RUNS = Number(process.env.RUNS || 100);
const rows = fs.readFileSync(LOG, 'utf8').split('\n').map((l) => l.match(/ new (\w+) #\d+ .*takeover=(\d+)ms mttr=(\d+)ms applied=10\/10/)).filter(Boolean)
  .map((m) => ({ type: m[1], takeover: +m[2] / 1000, mttr: +m[3] / 1000 }));
const stop = rows.filter((r) => r.type === 'stop');
if (!stop.length) throw new Error('SIGSTOP 실측이 없다');
const tk = stop.map((r) => r.takeover).sort((a, b) => a - b), mt = stop.map((r) => r.mttr).sort((a, b) => a - b);
const med = (a) => (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2;
const NEW = { ...C, lease: [Math.max(0, tk[0] - 0.3), tk[tk.length - 1] - 0.3], failoverReady: 0.3, grace: 3, committee: 0.35,
  reconnect: [1, 2], regAfterFailover: [0, 0.3], regAfterResume: [0, 0.3] };
const CONFIGS = [
  ['예전 설계 (10-13 보정: Lease 6 s, 커미티 3.2 s, 재접속 8~15 s)', C],
  ['지금 설계 (§48: Lease 2 s, 즉시 커미티 0.35 s, 유예 3 s, 재접속 1~2 s)', NEW],
  ['지금 설계, 정상 커미티 1.0 s (민감도)', { ...NEW, committee: 1.0 }],
];
console.log(`MTTR 실측(SIGSTOP ${stop.length}회): 인계 ${tk[0]}~${tk[tk.length - 1]} s(중앙 ${med(tk)}), MTTR ${mt[0]}~${mt[mt.length - 1]} s(중앙 ${med(mt)})`);
console.log(`→ 지금 설계 lease ${NEW.lease.map((x) => x.toFixed(2)).join('~')} s, RUNS ${RUNS}`);
const out = { mttr: { stop, all: rows }, runs: RUNS, configs: [] };
const fmt = (x) => x.toFixed(1).padStart(5);
for (const [name, cfg] of CONFIGS) {
  const res = { name, cfg, withByzantine: [], withoutByzantine: [] };
  for (const p of [1, 5, 10, 15]) for (const n of [1, 2, 3, 4, 5]) {
    res.withByzantine.push(experiment(n, p, cfg, RUNS, 1000 + p * 10 + n));
    res.withoutByzantine.push(experiment(n, p, { ...cfg, byzantine: 0 }, RUNS, 2000 + p * 10 + n));
  }
  out.configs.push(res);
  console.log(`\n## ${name}`);
  for (const key of ['withByzantine', 'withoutByzantine']) {
    console.log(`${key === 'withByzantine' ? 'Byzantine 3/10 포함' : 'pod 장애만'} — 평균 성공률 % (n = replica 1..5)`);
    for (const p of [1, 5, 10, 15]) console.log(`  장애 ${String(p).padStart(2)}%: ${res[key].filter((x) => x.failProb === p).map((x) => fmt(x.mean)).join(' ')}`);
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
