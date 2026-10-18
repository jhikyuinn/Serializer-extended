// §85 tx 별 블록 안 위치 분석: blockpos-<sys>.csv (block,pos,n,fn,user,urgent,valid,client_ts_ms)
//   node blockpos.js <csv 폴더>
// 정상 구간: 사용자 tx 가 든 블록 중 앞뒤 15% 를 뺀다. 쓰기 = fn 이 Query 가 아닌 것.
const fs = require('fs'), path = require('path');
const DIR = process.argv[2] || '.';
const USERS = ['User1', 'User2', 'User3', 'User4', 'User5'];
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : '-';
for (const sys of ['A1', 'FPP', 'BE']) {
  const f = path.join(DIR, `blockpos-${sys}.csv`); if (!fs.existsSync(f)) continue;
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split(',')).filter((r) => r[4] && r[4].startsWith('User'))
    .map(([b, p, n, fn, u, urg, v, ts]) => ({ b: +b, p: +p, n: +n, fn, u, v: +v, ts: +ts }));
  const blocks = [...new Set(rows.map((r) => r.b))].sort((a, b) => a - b);
  const lo = blocks[Math.floor(blocks.length * 0.15)], hi = blocks[Math.floor(blocks.length * 0.85)];
  const R = rows.filter((r) => r.b >= lo && r.b <= hi && r.n >= 20);
  const W = R.filter((r) => r.fn !== 'Query');
  console.log(`\n== ${sys}: 블록 ${blocks.length}개 중 ${lo}~${hi}, tx ${R.length}(쓰기 ${W.length}), 블록당 평균 ${(R.length / (hi - lo + 1)).toFixed(0)}`);
  // 1) 사용자별: 블록에 든 수, 평균 상대 위치(0 = 맨 앞, 1 = 맨 뒤), 쓰기 유효율
  console.log('| 사용자 | 블록에 든 tx | 평균 상대 위치 | 쓰기 유효율 | 블록 앞 1/5 에 든 몫 |');
  console.log('|---|---|---|---|---|');
  for (const u of USERS) {
    const ru = R.filter((r) => r.u === u), wu = W.filter((r) => r.u === u);
    const rel = ru.map((r) => r.p / Math.max(1, r.n - 1));
    const front = ru.filter((r) => r.p / Math.max(1, r.n - 1) < 0.2).length;
    console.log(`| ${u} | ${ru.length} | ${(rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(3)} | ${pct(wu.filter((r) => r.v).length, wu.length)}% | ${pct(front, ru.length)}% |`);
  }
  // 2) 위치 구간(5등분)별 쓰기 유효율
  const bins = [0, 1, 2, 3, 4].map((k) => W.filter((r) => Math.min(4, Math.floor(5 * r.p / Math.max(1, r.n))) === k));
  console.log(`위치 구간별 쓰기 유효율(앞 → 뒤): ${bins.map((b) => pct(b.filter((r) => r.v).length, b.length) + '%').join(' / ')}`);
  // 3) 같은 위치 구간 안에서 사용자별 쓰기 유효율 (앞 1/5, 뒤 1/5)
  for (const [k, name] of [[0, '앞 1/5'], [4, '뒤 1/5']]) {
    console.log(`  ${name} 안 사용자별 쓰기 유효율: ${USERS.map((u) => { const x = bins[k].filter((r) => r.u === u); return `${u.replace('User', 'U')} ${pct(x.filter((r) => r.v).length, x.length)}%`; }).join(', ')}`);
  }
  // 4) 같은 블록 안에서 클라이언트 생성 시각이 이른 정도(블록 안 최소 시각 대비, ms)
  const minTs = {}; for (const r of R) if (r.ts && (!(r.b in minTs) || r.ts < minTs[r.b])) minTs[r.b] = r.ts;
  console.log(`  블록 안에서 생성 시각 - 그 블록 최소 시각(ms, 평균): ${USERS.map((u) => { const x = R.filter((r) => r.u === u && r.ts); return `${u.replace('User', 'U')} ${(x.reduce((a, r) => a + r.ts - minTs[r.b], 0) / x.length).toFixed(0)}`; }).join(', ')}`);
}
