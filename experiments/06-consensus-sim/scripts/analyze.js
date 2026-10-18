// run.sh가 모은 기록과 w-node 로그에서 설정별 합의 성공률을 계산한다.
//
//   node analyze.js <결과 폴더> [기한(초)]
//
// 표준 출력: 설정별 요약 CSV. 각 설정 폴더에는 라운드별 결과(rounds.csv)를 쓴다.
// 성공 = 기록이 올라온 뒤 기한 안에 정상 w-node가 그 기록을 담은 블록을 받은 라운드.
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const deadlineMs = Number(process.argv[3] || 10) * 1000;
const BYZANTINE = 3; // bz1..bz3
const NODES = 10;

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

function analyze(dir) {
  // 올린 기록: 준비(w), 측정(r), 채움(f)을 올린 순서대로
  const records = readLines(path.join(dir, 'records.txt')).map((l) => {
    const [tag, ts] = l.split(' ');
    return { tag, ts: Number(ts) };
  });

  // 정상 노드들이 받은 블록. 로그의 elapsed는 블록에 담긴 가장 오래된 기록부터 잰 시간이므로
  // (받은 시각 - elapsed)로 그 블록의 첫 기록을 찾는다. 같은 블록은 가장 먼저 받은 시각을 쓴다.
  const blocks = new Map(); // 첫 기록의 순번 -> 받은 시각(ms)
  for (let i = BYZANTINE + 1; i <= NODES; i++) {
    for (const l of readLines(path.join(dir, `bz${i}.log`))) {
      const m = l.match(/^(\S+?)(\.\d+)?Z .*consensus elapsed time: ([\d.]+) seconds/);
      if (!m) continue;
      const at = Date.parse(m[1] + (m[2] || '').slice(0, 4) + 'Z');
      const oldest = at - Number(m[3]) * 1000;
      let first = -1;
      let best = 1000;
      records.forEach((r, idx) => {
        const d = Math.abs(r.ts - oldest);
        if (d < best) { best = d; first = idx; }
      });
      if (first < 0) continue; // 이 설정에서 올린 기록이 아니다
      if (!blocks.has(first) || at < blocks.get(first)) blocks.set(first, at);
    }
  }
  const firsts = [...blocks.keys()].sort((a, b) => a - b);

  // Byzantine 노드가 리더로서 움직인 시각
  const byz = [];
  for (let i = 1; i <= BYZANTINE; i++) {
    for (const l of readLines(path.join(dir, `bz${i}.log`))) {
      const m = l.match(/^(\S+?)(\.\d+)?Z .*Byzantine leader \(round \d+\): (delaying|sending)/);
      if (m) byz.push({ at: Date.parse(m[1] + 'Z'), kind: m[3] === 'delaying' ? 'delay' : 'sign' });
    }
  }

  const events = new Map();
  for (const l of readLines(path.join(dir, 'events.csv')).slice(1)) {
    const [round, at, pods, active, frozen] = l.split(',');
    events.set(Number(round), { at: Number(at), pods: Number(pods), active: active || '', frozen: frozen || '' });
  }
  const periodMs = events.has(2) ? events.get(2).at - events.get(1).at : 10000;

  const rows = [];
  records.forEach((r, idx) => {
    if (!r.tag.startsWith('r')) return;
    const round = Number(r.tag.slice(1));
    // 이 기록을 담은 블록: 첫 기록이 이 기록이거나 그보다 앞선 블록 중 마지막 것
    let first = -1;
    for (const f of firsts) { if (f <= idx) first = f; else break; }
    let latency = Infinity;
    if (first >= 0 && blocks.get(first) >= r.ts) latency = blocks.get(first) - r.ts;

    const ev = events.get(round) || { pods: 0, active: '', frozen: '' };
    const activeFrozen = (e) => e.active.split(';').filter(Boolean).some((a) => e.frozen.includes(a));
    // 이 기록을 늦출 수 있었던 구간: 바로 앞 블록이 기록된 뒤부터 이 기록의 블록까지.
    // 앞 라운드가 밀려 한 블록에 묶인 기록들은 같은 원인을 나눠 갖는다.
    const pos = firsts.indexOf(first);
    const begin = Math.min(pos > 0 ? blocks.get(firsts[pos - 1]) : r.ts, r.ts) - 1000;
    const end = Number.isFinite(latency) ? r.ts + latency : r.ts + deadlineMs;
    const hit = byz.filter((b) => b.at >= begin && b.at <= end);
    // 멈춘 pod는 한 라운드 동안 멈춰 있으므로 구간 시작 한 라운드 전의 것부터 본다
    const frozenInWindow = [...events.values()].some(
      (e) => e.frozen !== '' && e.at >= begin - periodMs && e.at <= end);
    rows.push({
      round,
      ts: r.ts,
      latency,
      ok: latency <= deadlineMs,
      frozen: ev.frozen,
      activeFrozen: activeFrozen(ev),
      anyFrozen: frozenInWindow,
      byz: [...new Set(hit.map((b) => b.kind))].join('+'),
    });
  });

  fs.writeFileSync(
    path.join(dir, 'rounds.csv'),
    'round,record_ms,latency_ms,success,frozen,active_frozen,byzantine_leader\n' +
      rows.map((x) => [x.round, x.ts, Number.isFinite(x.latency) ? x.latency : '', x.ok ? 1 : 0,
        x.frozen, x.activeFrozen ? 1 : 0, x.byz].join(',')).join('\n') + '\n');
  return rows;
}

const header = 'replicas,fail_prob_pct,rounds,success,success_rate_pct,success_rate_no_byzantine_pct,' +
  'fail_byzantine_only,fail_pod_only,fail_both,fail_other,' +
  'rounds_with_frozen_pod,rounds_with_frozen_active,rounds_with_byzantine_leader,median_latency_ms';
console.log(header);

const dirs = fs.readdirSync(out)
  .map((d) => ({ d, m: d.match(/^n(\d+)_p(\d+)$/) }))
  .filter((x) => x.m && fs.existsSync(path.join(out, x.d, 'done')))
  .sort((a, b) => Number(a.m[2]) - Number(b.m[2]) || Number(a.m[1]) - Number(b.m[1]));

for (const { d, m } of dirs) {
  const rows = analyze(path.join(out, d));
  const ok = rows.filter((x) => x.ok).length;
  const failed = rows.filter((x) => !x.ok);
  const pod = (x) => x.anyFrozen;
  const lat = rows.map((x) => x.latency).filter(Number.isFinite).sort((a, b) => a - b);
  console.log([
    m[1], m[2], rows.length, ok, rows.length ? (100 * ok / rows.length).toFixed(1) : '',
    // Byzantine 리더가 걸리지 않은 라운드만 놓고 본 성공률 (pod 장애의 영향만 남는다)
    (() => {
      const clean = rows.filter((x) => !x.byz);
      return clean.length ? (100 * clean.filter((x) => x.ok).length / clean.length).toFixed(1) : '';
    })(),
    failed.filter((x) => x.byz && !pod(x)).length,
    failed.filter((x) => !x.byz && pod(x)).length,
    failed.filter((x) => x.byz && pod(x)).length,
    failed.filter((x) => !x.byz && !pod(x)).length,
    rows.filter((x) => x.frozen !== '').length,
    rows.filter((x) => x.activeFrozen).length,
    rows.filter((x) => x.byz).length,
    lat.length ? lat[Math.floor(lat.length / 2)] : '',
  ].join(','));
}
