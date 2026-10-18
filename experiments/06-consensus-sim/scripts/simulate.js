// 원본: 브랜치 worktree-wnode-byzantine 의 watchdog/experiments/fig57/simulate.js (2026-10-13). §87 에서 §48 설계(Lease 2 s, 즉시 커미티, 유예 3 s)를 넣었다.
// Figure 5.7 시뮬레이션: s-node replica 수와 pod별 장애 확률에 따른 합의 성공률.
//
//   node simulate.js [결과 JSON 경로]
//
// 실제 스택(run.sh)과 같은 순서로 사건을 진행시키되, 걸리는 시간은 시험 실행에서 잰 값을 쓴다.
// 라운드마다 abort 기록 하나가 들어오고, 기록부터 블록까지 DEADLINE 안이면 성공이다.
//
// 시험 실행(2026-10-13, w-node 10개 중 Byzantine 3개, 120라운드)에서 잰 값
//   정상 합의 0.40초 / 커미티 구성 3.2초 / Byzantine 리더 비율 30%
//   서명 위조 리더: 5초 뒤 실패 통보, 새 커미티까지 3.2초 또는 4.8초 (기록부터 8.9초 또는 10.5초)
//   지연 리더: 10초 단위 정체 확인이 두 번 연속 걸리면 재등록 (기록부터 20~33초)
//   활성 pod 멈춤: 새 커미티까지 9.5~11.6초 (인계 시험 8번, Lease 6초).
//     Lease 3초에서는 6.9~9.5초.
//     멈춘 pod가 이미 받아 둔 등록이 사라진 경우는 w-node가 다시 붙어야 해서 더 걸린다
//     (8~15초 뒤 재등록, 인계 시험에서는 재지 못해 이전 관찰값을 쓴다).
//   pod가 하나뿐일 때: 풀린 뒤 3.65초에 블록
const fs = require('fs');

const C = {
  rounds: 500,
  warmup: 5,
  period: 10, // 라운드 간격(초)
  deadline: 10, // 성공 기한(초)
  downRounds: 3, // 멈춘 pod가 멈춰 있는 라운드 수
  nodes: 10,
  byzantine: 3,
  consensus: 0.4,
  committee: 3.2,
  signTimeout: 5,
  signSlowProb: 0.45, // 서명 위조 뒤 새 커미티가 1.6초 더 걸리는 비율
  signSlowExtra: 1.6,
  delay: 30, // -byzdelay
  stallPeriod: 10,
  stallChecks: 2,
  // 인계 시험(replica 3개, 8번)에서 활성 pod를 멈춘 뒤 새 커미티까지 9.5~11.6초였다.
  // 커미티 구성 3.2초를 빼면 6.3~8.4초이고, 아래 세 값의 합이 그 범위다.
  lease: [6, 7.4], // 활성 pod가 멈춘 뒤 다른 pod가 활성이 되기까지
  failoverReady: 0.3,
  regAfterFailover: [0, 0.7], // 막혀 있던 등록이 새 활성 pod에 닿기까지
  regAfterResume: [0, 0.5],
  reconnect: [8, 15], // 활성 pod가 바뀐 뒤 w-node가 다시 붙어 재등록하기까지
  restart: 5, // 자격을 잃은 pod가 풀린 뒤 대기 상태로 돌아오기까지
  activeActive: false, // true면 모든 pod가 동시에 일하는 구조로 계산한다 (가정, 구현되지 않음)
  aaRetry: 1.2, // 그 구조에서 멈춘 pod에 닿은 요청이 다른 pod로 다시 가기까지
  dt: 0.05,
};

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 한 번의 실험(준비 라운드 + rounds 라운드)을 돌려 성공한 라운드 수를 돌려준다.
function runOnce(n, p, cfg, rand) {
  const u = (r) => r[0] + (r[1] - r[0]) * rand();
  const byzProb = cfg.byzantine / cfg.nodes;
  const leaderType = () => (rand() >= byzProb ? 'honest' : rand() < 0.5 ? 'sign' : 'delay');

  // s-node
  const frozen = Array(n).fill(false);
  const down = Array(n).fill(0);
  const lostLease = Array(n).fill(false);
  const restartUntil = Array(n).fill(0);
  let active = 0;
  let activeFrozenAt = 0;
  let leaseFor = 0;
  let upSince = -1e9;
  let upKind = 'resume';
  let reconnectAt = Infinity;
  // activeActive: 모든 pod가 등록 정보를 함께 갖고 동시에 일한다고 가정한 구조(구현되지 않음).
  // 떠 있는 pod가 하나라도 있으면 커미티를 만들 수 있고, 인계가 없다.
  const aa = !!cfg.activeActive;
  let aaWasUp = true;
  const snodeUp = (t) => (aa ? frozen.some((f) => !f) : !frozen[active]) && t >= upSince;

  // w-node
  let committee = { type: 'honest' };
  let reg = null; // 재등록 중: {start, jResume, jFailover}
  let sched = null; // s-node가 커미티를 만들 예정: {at, on}
  let run = null; // 합의 진행 중
  const queue = []; // 아직 블록에 들어가지 못한 기록: {round, at}
  let blocks = 0;
  let lastSeen = -1;
  let stalled = 0;
  let success = 0;

  const requestCommittee = (t) => {
    if (reg || sched) return;
    // 돌아가며 받는 구조에서는 요청이 멈춘 pod에 닿을 수 있다. 그 요청은 시간 초과 뒤 다른 pod로 다시 간다.
    const downShare = frozen.filter(Boolean).length / n;
    const retry = aa && rand() < downShare ? cfg.aaRetry : 0;
    reg = { start: t + retry, jResume: u(cfg.regAfterResume), jFailover: u(cfg.regAfterFailover) };
  };

  const phase = rand() * cfg.period; // 라운드 시각과 벽시계 10초 눈금의 어긋남
  const total = cfg.warmup + cfg.rounds;
  const end = total * cfg.period + 120;
  let nextRound = 0;
  let nextStall = cfg.stallPeriod;

  for (let step = 0; step * cfg.dt < end; step++) {
    const now = step * cfg.dt;

    // 라운드 시작: pod 장애를 뽑고(준비 라운드에는 뽑지 않는다) 기록을 넣는다
    if (nextRound < total && now >= phase + nextRound * cfg.period) {
      const round = nextRound - cfg.warmup + 1;
      if (round >= 1) {
        for (let s = 0; s < n; s++) {
          if (down[s] > 0) {
            if (--down[s] === 0) {
              frozen[s] = false;
              if (lostLease[s]) { lostLease[s] = false; restartUntil[s] = now + cfg.restart; }
              else if (s === active) { upSince = now; upKind = 'resume'; }
            }
          } else if (rand() < p) {
            down[s] = cfg.downRounds;
            frozen[s] = true;
            if (s === active) { activeFrozenAt = now; leaseFor = u(cfg.lease); }
          }
        }
      }
      queue.push({ round, at: now });
      nextRound++;
    }
    if (nextRound === total && now >= phase + (total - 1 + cfg.downRounds) * cfg.period) {
      for (let s = 0; s < n; s++) { // 실험이 끝나면 모두 푼다
        if (frozen[s]) {
          frozen[s] = false; down[s] = 0;
          if (s === active) { upSince = now; upKind = 'resume'; }
        }
      }
    }

    // 활성 pod가 멈춰 Lease가 끝났으면 떠 있는 다른 pod가 넘겨받는다
    if (aa) { // 모두 멈췄다가 하나라도 풀리면 바로 일한다
      const up = frozen.some((f) => !f);
      if (up && !aaWasUp) { upSince = now; upKind = 'resume'; }
      aaWasUp = up;
    }
    if (!aa && frozen[active] && now >= activeFrozenAt + leaseFor) {
      let next = -1;
      for (let s = 0; s < n; s++) {
        if (s !== active && !frozen[s] && now >= restartUntil[s]) { next = s; break; }
      }
      if (next >= 0) {
        lostLease[active] = true;
        reconnectAt = Math.max(now, activeFrozenAt + u(cfg.reconnect));
        active = next;
        upSince = now + cfg.failoverReady;
        upKind = 'failover';
        if (sched) { sched = null; reg = null; } // 멈춘 pod가 받아 둔 등록은 사라진다
      }
    }
    if (now >= reconnectAt) { reconnectAt = Infinity; requestCommittee(now); }

    // 정체 확인: 밀린 기록이 있는데 원장이 두 번 연속 그대로면 모두 다시 등록한다
    if (now >= nextStall) {
      nextStall += cfg.stallPeriod;
      const pending = queue.length > 0;
      if (!pending || blocks !== lastSeen) { lastSeen = blocks; stalled = 0; }
      else if (++stalled >= cfg.stallChecks) { stalled = 0; requestCommittee(now); }
    }

    // 등록이 활성 s-node에 닿으면 3초 뒤 커미티가 정해진다
    if (reg && !sched && snodeUp(now)) {
      const jitter = upKind === 'failover' ? reg.jFailover : reg.jResume;
      const accept = upSince > reg.start ? upSince + jitter : reg.start;
      // §48 설계: 활성이 된 뒤 grace 초 동안은 커미티를 만들지 않는다(그 뒤 committee 초). 예전 설계는 grace 0
      const base = now + cfg.committee;
      const at = !aa && upKind === 'failover' ? Math.max(base, upSince + (cfg.grace || 0) + cfg.committee) : base;
      if (now >= accept) sched = { at, on: active };
    }
    if (sched && now >= sched.at && snodeUp(now) && (aa || sched.on === active)) {
      committee = { type: leaderType() };
      sched = null; reg = null;
      run = null; // 이전 커미티의 리더는 자격을 잃는다
    }

    // 합의
    if (committee && !run && queue.length > 0) {
      const type = committee.type;
      const members = queue.length; // 리더가 읽은 기록 수
      if (type === 'honest') run = { endAt: now + cfg.consensus, members, ok: true };
      else if (type === 'sign') run = { endAt: now + cfg.consensus + cfg.signTimeout, members, ok: false };
      else run = { endAt: now + cfg.delay + cfg.consensus, members, ok: true };
    }
    if (run && now >= run.endAt) {
      committee = null;
      if (run.ok) {
        blocks++;
        for (const rec of queue.splice(0, run.members)) {
          if (rec.round >= 1 && now - rec.at <= cfg.deadline) success++;
        }
        requestCommittee(now);
      } else {
        requestCommittee(now + (rand() < cfg.signSlowProb ? cfg.signSlowExtra : 0));
      }
      run = null;
    }
  }
  return success;
}

function experiment(n, pPct, cfg, runs, seed) {
  const rand = rng(seed);
  const rates = [];
  for (let i = 0; i < runs; i++) rates.push(100 * runOnce(n, pPct / 100, cfg, rand) / cfg.rounds);
  rates.sort((a, b) => a - b);
  const q = (f) => rates[Math.min(rates.length - 1, Math.floor(f * rates.length))];
  return {
    replicas: n,
    failProb: pPct,
    mean: rates.reduce((a, b) => a + b, 0) / runs,
    p5: q(0.05),
    p95: q(0.95),
  };
}

if (require.main === module && process.env.LEGACY_MAIN) { // 2026-10-13 의 출력(예전 설계 비교용)
  const RUNS = Number(process.env.RUNS || 200);
  const out = { config: C, runs: RUNS, withByzantine: [], withoutByzantine: [],
    aaWithByzantine: [], aaWithoutByzantine: [], check: [], variants: [] };
  // 시험한 방안: Lease 3초(인계 6.9~9.5초 실측)와 기한 20초. 장애 15%에서 비교한다.
  const LEASE3 = { lease: [3.5, 5.3], reconnect: [5, 12] };
  for (const [name, over] of [
    ['현재 (Lease 6초, 기한 10초)', {}],
    ['Lease 3초', LEASE3],
    ['기한 20초', { deadline: 20 }],
    ['Lease 3초 + 기한 20초', { ...LEASE3, deadline: 20 }],
  ]) {
    out.variants.push({
      name,
      overall: [1, 2, 3, 4, 5].map((n) => experiment(n, 15, { ...C, ...over }, RUNS, 4000 + n).mean),
      podOnly: [1, 2, 3, 4, 5].map((n) => experiment(n, 15, { ...C, ...over, byzantine: 0 }, RUNS, 4100 + n).mean),
    });
  }
  for (const p of [1, 5, 10, 15]) {
    for (const n of [1, 2, 3, 4, 5]) {
      out.withByzantine.push(experiment(n, p, C, RUNS, 1000 + p * 10 + n));
      out.withoutByzantine.push(experiment(n, p, { ...C, byzantine: 0 }, RUNS, 2000 + p * 10 + n));
      // 모든 pod가 동시에 일하는 구조(가정)
      out.aaWithByzantine.push(experiment(n, p, { ...C, activeActive: true }, RUNS, 6000 + p * 10 + n));
      out.aaWithoutByzantine.push(experiment(n, p, { ...C, activeActive: true, byzantine: 0 }, RUNS, 7000 + p * 10 + n));
    }
  }
  // 시험 실행(30라운드씩)과 같은 조건
  for (const [n, d, measured] of [[1, 1, 63.3], [3, 1, 73.3], [1, 3, 50.0], [3, 3, 70.0]]) {
    const r = experiment(n, 15, { ...C, downRounds: d }, RUNS, 3000 + n * 10 + d);
    out.check.push({ replicas: n, downRounds: d, simulated: r.mean, measured30Rounds: measured });
  }
  const fmt = (x) => x.toFixed(1).padStart(5);
  for (const key of ['withByzantine', 'withoutByzantine', 'aaWithByzantine', 'aaWithoutByzantine']) {
    console.log(`\n${key}: mean success rate % (5%~95% of single ${C.rounds}-round experiments)`);
    console.log('fail%   n=1            n=2            n=3            n=4            n=5');
    for (const p of [1, 5, 10, 15]) {
      const row = out[key].filter((x) => x.failProb === p)
        .map((x) => `${fmt(x.mean)} (${fmt(x.p5)}~${fmt(x.p95)})`).join(' ');
      console.log(`${String(p).padStart(4)}  ${row}`);
    }
  }
  console.log('\nvariants at 15% (overall / pod failures only), n=1..5');
  for (const v of out.variants) {
    console.log(`${v.name.padEnd(28)} ${v.overall.map(fmt).join(' ')}   |  ${v.podOnly.map(fmt).join(' ')}`);
  }
  console.log('\ncheck against the pilot runs (15%, 30 rounds each)');
  for (const c of out.check) {
    console.log(`n=${c.replicas} down=${c.downRounds} round(s): simulated ${c.simulated.toFixed(1)}%  measured ${c.measured30Rounds}%`);
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}

module.exports = { C, runOnce, experiment };
