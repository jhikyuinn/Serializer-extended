// §84 실험 4 요약: 성능 + 사용자 공정성. results/fair-<부하>-<라벨>/<SYS>/u<긴급>/rep<n>
//   node fair.js [results 폴더] [출력 json]
// 공정성(쓰기 tx 기준, 정상 구간):
//   Jain = (Σx)² / (n·Σx²), x = 사용자별 쓰기 성공률. 1 이면 고르다
//   최소/최대 = 가장 불리한 사용자의 성공률 / 가장 유리한 사용자의 성공률
//   abort 쏠림 = 실패가 가장 많은 사용자가 전체 실패에서 차지하는 몫 (고르면 0.2)
//   최대 연속 실패 = 한 사용자가 보낸 쓰기 tx 가 보낸 순서대로 연속 실패한 최대 횟수 (tx-*.json, 굶주림)
//   긴급 켬일 때는 VIP(User3)를 뺀 4명의 Jain 도 낸다
const fs = require('fs'), path = require('path');
const R = process.argv[2] || path.join(__dirname, '../../../bench/zipfbench/results');
const OUTJ = process.argv[3];
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
const jain = (xs) => { const s = xs.reduce((a, b) => a + b, 0), q = xs.reduce((a, b) => a + b * b, 0); return q ? s * s / (xs.length * q) : NaN; };
const USERS = ['User1', 'User2', 'User3', 'User4', 'User5'];

function one(d) {
  const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))), dur = meta.duration - (meta.warmupSec || 0), warm = (meta.warmupSec || 0) * 1000;
  const a = {}, q = {}, ug = {}, uw = {}; // uw[user] = {tot, ok, fail}
  for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f))), t = j.tallySteady;
    for (const [k, x] of Object.entries(t.all)) a[k] = (a[k] || 0) + x;
    for (const [k, x] of Object.entries(t.query)) q[k] = (q[k] || 0) + x;
    for (const [k, x] of Object.entries(t.urgent || {})) ug[k] = (ug[k] || 0) + x;
    const w = uw[j.user] || (uw[j.user] = { tot: 0, ok: 0 });
    for (const kind of ['normalWrite', 'urgent']) if (t[kind]) { w.tot += t[kind].total; w.ok += t[kind].success; }
  }
  const rate = (u) => uw[u] && uw[u].tot ? uw[u].ok / uw[u].tot : NaN;
  const xs = USERS.map(rate).filter((x) => !Number.isNaN(x));
  const fails = USERS.map((u) => uw[u] ? uw[u].tot - uw[u].ok : 0), ft = fails.reduce((p, c) => p + c, 0);
  // 연속 실패: 사용자별로 워커 파일을 합쳐 보낸 시각 순서로
  let streak = 0; const streakBy = {};
  for (const u of USERS) {
    const rows = [];
    for (const f of fs.readdirSync(d).filter((f) => f.startsWith(`tx-${u}-`))) for (const r of JSON.parse(fs.readFileSync(path.join(d, f)))) if (r[0] >= warm && (r[1] === 'n' || r[1] === 'u')) rows.push(r);
    rows.sort((x, y) => x[0] - y[0]);
    let cur = 0, mx = 0; for (const r of rows) { if (r[2] === 's') cur = 0; else { cur++; if (cur > mx) mx = cur; } }
    streakBy[u] = mx; if (mx > streak) streak = mx;
  }
  const nonVip = USERS.filter((u) => u !== 'User3').map(rate).filter((x) => !Number.isNaN(x));
  return {
    sp: a.success / dur, rate: 100 * a.success / a.total, qrate: 100 * q.success / q.total, lat: a.latencySuccessSum / a.success,
    jain: jain(xs), minmax: Math.min(...xs) / Math.max(...xs), cv: sd(xs) / mean(xs), conc: ft ? Math.max(...fails) / ft : NaN, streak,
    u5u1: rate('User5') / rate('User1'), urg: ug.total ? 100 * ug.success / ug.total : NaN, jain4: jain(nonVip),
    perUser: Object.fromEntries(USERS.map((u) => [u, rate(u)])), streakBy,
  };
}
const LABELS = [['A1', 'A1', 'Fabric'], ['FPP', 'FPP', 'Fabric++'], ['HTF', 'HTF', 'HTFabric(WARD)'], ['BE05', 'BE', 'Serializer 1/0.5'], ['BE075', 'BE', 'Serializer 1/0.75(논문)'], ['BE1', 'BE', 'Serializer 1/1'],
  ['BE075-a0', 'BE', 'Serializer 논문, α 0'], ['BE075-a3', 'BE', 'Serializer 논문, α 3']];
const all = {};
for (const mode of ['smallbank', 'custom']) for (const u of ['u0', 'u1']) {
  console.log(`\n### ${mode}, 긴급 ${u === 'u1' ? '켬' : '끔'} — 3회 평균`);
  console.log(`| 시스템 | 회 | 성공/s | 성공률 | Query 성공률 | 커밋 지연 | Jain | 최소/최대 | U5/U1 | abort 쏠림 | 최대 연속 실패 |${u === 'u1' ? ' 긴급 성공률 | Jain(VIP 제외) |' : ''}`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|${u === 'u1' ? '---|---|' : ''}`);
  for (const [lab, sys, name] of LABELS) {
    const base = path.join(R, `fair-${mode}-${lab}`, sys, u); if (!fs.existsSync(base)) continue;
    const rs = fs.readdirSync(base).map((r) => path.join(base, r)).filter((d) => fs.existsSync(path.join(d, 'meta.json')) && fs.readdirSync(d).some((f) => f.startsWith('user-'))).map(one);
    if (!rs.length) continue;
    const g = (k, dd = 1) => `${mean(rs.map((r) => r[k])).toFixed(dd)}${rs.length > 1 ? ` ± ${sd(rs.map((r) => r[k])).toFixed(dd)}` : ''}`;
    all[`${mode}|${u}|${lab}`] = rs;
    console.log(`| ${name} | ${rs.length} | ${g('sp', 0)} | ${g('rate')}% | ${g('qrate')}% | ${g('lat', 0)} ms | ${g('jain', 3)} | ${g('minmax', 2)} | ${g('u5u1', 2)} | ${g('conc', 2)} | ${g('streak', 0)} |${u === 'u1' ? ` ${g('urg')}% | ${g('jain4', 3)} |` : ''}`);
  }
}
if (OUTJ) fs.writeFileSync(OUTJ, JSON.stringify(all, null, 1));
