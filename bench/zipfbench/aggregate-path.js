#!/usr/bin/env node
'use strict';

// 커밋 경로 지연을 구간별로 나눈다 (NOTES §36).
//
//   node aggregate-path.js results/<RUN_ID> [...]
//
// 입력: 실행 폴더마다 processor.log 의 [Timing]·[Batch] 줄과 peer-commits.log 의 "Committed block" 줄.
// 오더러는 배치 하나씩 보내고 결과를 기다리므로(§18) 배치 i 와 블록 i 가 차례로 짝이 된다.
// 짝은 블록 tx 수 = 배치의 ordered 수로 확인한다(맞지 않는 실행은 건너뛴다).
//
// 구간 (배치마다, ms)
//   간격      다음 배치를 incoming 에 보낸 시각 - 이 배치를 보낸 시각 (오더러 한 바퀴)
//   전송      Produce(Kafka 레코드 시각) → 프로세서 수신
//   디코딩·메타·통계읽기·정렬·저장·직렬화  프로세서 안 ([Timing])
//   commit→블록  프로세서가 commit 을 보낸 뒤 → 피어가 블록 커밋을 마친 시각
//                (commit 토픽 → 오더러 → 블록 생성·raft → 피어 전달 → 검증·커밋)
//   피어 커밋  그중 피어가 블록을 검증·커밋한 시간 (peer 로그 "in Xms")
//   왕복      Produce → 피어 커밋 끝
// 프로세서를 거치지 않는 시스템(A2)은 블록 간격과 피어 커밋 시간만 낸다.

const fs = require('fs');
const path = require('path');

const LABEL = { A2: 'Fabric 2.5.10', FPP: 'Fabric++', HTF: 'HTFabric (WARD)', B: 'SCC 변형', BE: 'Serializer' };
const ORDER = ['A2', 'FPP', 'HTF', 'B', 'BE'];

function readLines(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n');
  } catch (e) {
    return [];
  }
}

function parseRun(dir) {
  const batches = [];
  let pendingOrdered = null;
  for (const l of readLines(path.join(dir, 'processor.log'))) {
    let m = l.match(/\[Batch\] n=(\d+) ordered=(\d+) aborted=(\d+)/);
    if (m) {
      pendingOrdered = { n: +m[1], ordered: +m[2], aborted: +m[3] };
      continue;
    }
    m = l.match(/\[Timing\] n=(\d+) .*create=(\d+) recv=(\d+) decode=([\d.]+) meta=([\d.]+) load=([\d.]+) sched=([\d.]+) save=([\d.]+) encode=([\d.]+)/);
    if (m && pendingOrdered) {
      const b = { ...pendingOrdered, create: +m[2], recv: +m[3], decode: +m[4], meta: +m[5], load: +m[6], sched: +m[7], save: +m[8], encode: +m[9] };
      b.proc = b.decode + b.meta + b.load + b.sched + b.save + b.encode;
      b.done = b.recv + b.proc;
      batches.push(b);
      pendingOrdered = null;
    }
  }
  const blocks = [];
  for (const l of readLines(path.join(dir, 'peer-commits.log'))) {
    const m = l.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) UTC .*Committed block \[(\d+)\] with (\d+) transaction\(s\) in (\d+)ms/);
    if (m) blocks.push({ t: Date.parse(m[1].replace(' ', 'T') + 'Z'), num: +m[2], txs: +m[3], peerMs: +m[4] });
  }
  // 오더러 (-t 로 붙은 도커 시각). [COMMITDATA] 다음의 Created block 이 그 결과로 만든 블록이다
  const ord = { commits: [], created: new Map(), written: new Map(), delivered: [] };
  // 도커 시각(줄 맨 앞). Fabric 로거 줄은 자기 시각(UTC)이 더 정확하므로 그것을 쓴다
  const ts = (l) => Date.parse(l.slice(0, 23) + 'Z');
  const fabTs = (l) => {
    const m = l.match(/Z (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) UTC/);
    return m ? Date.parse(`${m[1]}T${m[2]}Z`) : ts(l);
  };
  for (const l of readLines(path.join(dir, 'orderer.log'))) {
    let m;
    if (/Delivered message to topic/.test(l)) ord.delivered.push(ts(l));
    else if ((m = l.match(/\[COMMITDATA\] id=\S* order=(\d+)/))) ord.commits.push({ t: ts(l), order: +m[1], block: null, ack: ord.delivered[ord.delivered.length - 1] });
    else if ((m = l.match(/Created block \[(\d+)\]/))) {
      ord.created.set(+m[1], fabTs(l));
      const c = ord.commits[ord.commits.length - 1];
      if (c && c.block === null) c.block = +m[1];
    } else if ((m = l.match(/Writing block \[(\d+)\]/))) ord.written.set(+m[1], fabTs(l));
  }
  return { batches, blocks, ord };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function pairUp(batches, blocks) {
  // 끝에서부터 맞춘다 (앞쪽 블록에는 설정·체인코드 설치 블록이 섞일 수 있다)
  const k = Math.min(batches.length, blocks.length);
  const bs = batches.slice(batches.length - k);
  const bl = blocks.slice(blocks.length - k);
  const mismatch = bs.filter((b, i) => b.ordered !== bl[i].txs).length;
  return { bs, bl, mismatch };
}

const rows = [];
for (const root of process.argv.slice(2)) {
  for (const sys of fs.readdirSync(root)) {
    const sysDir = path.join(root, sys);
    if (!fs.statSync(sysDir).isDirectory()) continue;
    for (const u of fs.readdirSync(sysDir)) {
      for (const rep of fs.readdirSync(path.join(sysDir, u))) {
        const dir = path.join(sysDir, u, rep);
        if (!fs.existsSync(path.join(dir, 'peer-commits.log'))) continue;
        const { batches, blocks, ord } = parseRun(dir);
        const r = { run: path.basename(root), sys, u, rep };
        // 블록 간격·크기 (워밍업 이후: tx 가 10 건 이상인 블록)
        const bl = blocks.filter((b) => b.txs >= 10);
        r.blockGap = mean(bl.slice(1).map((b, i) => b.t - bl[i].t));
        r.blockTxs = mean(bl.map((b) => b.txs));
        r.peerMs = mean(bl.map((b) => b.peerMs));
        // 오더러 단계 (A2 포함): 블록 생성 → 원장 쓰기(raft) → 피어 커밋 끝
        const peerAt = new Map(blocks.map((b) => [b.num, b.t]));
        const nums = [...ord.created.keys()].filter((n) => ord.written.has(n) && peerAt.has(n));
        if (nums.length) {
          r.raft = mean(nums.map((n) => ord.written.get(n) - ord.created.get(n)));
          r.toPeer = mean(nums.map((n) => peerAt.get(n) - ord.written.get(n)));
        }
        if (batches.length) {
          const { bs, bl: pb, mismatch } = pairUp(batches.filter((b) => b.n >= 10), blocks.filter((b) => b.txs >= 1));
          r.mismatch = mismatch;
          if (mismatch <= bs.length * 0.05) {
            r.n = mean(bs.map((b) => b.n));
            r.gap = mean(bs.slice(1).map((b, i) => b.create - bs[i].create));
            r.kafkaIn = mean(bs.map((b) => b.recv - b.create));
            for (const f of ['decode', 'meta', 'load', 'sched', 'save', 'encode', 'proc']) r[f] = mean(bs.map((b) => b[f]));
            r.toBlock = mean(bs.map((b, i) => pb[i].t - b.done));
            r.roundTrip = mean(bs.map((b, i) => pb[i].t - b.create));
            // 오더러: 배치 → (피어 짝으로 얻은) 블록 번호 → 그 블록을 만든 [COMMITDATA]
            const byBlock = new Map(ord.commits.filter((c) => c.block !== null).map((c) => [c.block, c]));
            const tri = bs.map((x, i) => ({ x, c: byBlock.get(pb[i].num) })).filter((p) => p.c && p.c.order === p.x.ordered);
            if (tri.length) {
              r.ordPaired = tri.length + "/" + bs.length;
              r.ack = mean(tri.map((p) => p.c.ack - p.x.create).filter((v) => v >= 0 && v < 5000));
              r.commitIn = mean(tri.map((p) => p.c.t - p.x.done));
              r.mkBlock = mean(tri.map((p) => ord.created.get(p.c.block) - p.c.t));
            }
          }
        }
        rows.push(r);
      }
    }
  }
}

// 시스템 × 긴급 별 평균
const groups = new Map();
for (const r of rows) {
  const k = `${r.run}|${r.sys}|${r.u}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const keys = [...groups.keys()].sort((a, b) => {
  const [ra, sa, ua] = a.split('|');
  const [rb, sb, ub] = b.split('|');
  return ra.localeCompare(rb) || ORDER.indexOf(sa) - ORDER.indexOf(sb) || ua.localeCompare(ub);
});
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const cols = ['n', 'gap', 'kafkaIn', 'decode', 'meta', 'load', 'sched', 'save', 'encode', 'proc', 'toBlock', 'peerMs', 'roundTrip', 'blockGap', 'blockTxs'];
console.log('| 실행 | 시스템 | 긴급 | 배치 크기 | 간격 | 전송(→프로세서) | 디코딩 | 메타 | 통계 읽기 | 정렬 | 저장 | 직렬화 | 프로세서 합 | commit→블록 커밋 | (피어 커밋) | 왕복 | 블록 간격 | 블록 tx | 짝 안 맞음 |');
console.log('|' + '---|'.repeat(19));
for (const k of keys) {
  const rs = groups.get(k);
  const [run, sys, u] = k.split('|');
  const m = (c) => mean(rs.map((r) => r[c]).filter(Number.isFinite));
  const vals = cols.map((c) => f(m(c), ['n', 'gap', 'kafkaIn', 'toBlock', 'roundTrip', 'blockGap', 'blockTxs'].includes(c) ? 0 : 1));
  console.log(`| ${run} | ${LABEL[sys] || sys} | ${u.replace('u', '')} | ${vals.join(' | ')} | ${rs.map((r) => (r.mismatch === undefined ? '-' : r.mismatch)).join('/')} |`);
}

// 오더러 로그(orderer.log)가 있는 실행: 배치 하나가 블록이 되기까지를 차례로 나눈다
const withOrd = keys.filter((k) => groups.get(k).some((r) => Number.isFinite(r.raft)));
if (withOrd.length) {
  console.log('\n## 배치 하나의 왕복, 오더러 로그 포함 (ms, 배치 평균)\n');
  console.log('| 실행 | 시스템 | 긴급 | incoming 전송 확인 | Produce→프로세서 수신 | 프로세서 | commit→오더러 수신 | 오더러 블록 생성 | raft·원장 쓰기 | →피어 커밋 끝 | 짝 맞은 배치 |');
  console.log('|' + '---|'.repeat(11));
  for (const k of withOrd) {
    const rs = groups.get(k);
    const [run, sys, u] = k.split('|');
    const m = (c) => f(mean(rs.map((r) => r[c]).filter(Number.isFinite)), 1);
    console.log(`| ${run} | ${LABEL[sys] || sys} | ${u.replace('u', '')} | ${m('ack')} | ${m('kafkaIn')} | ${m('proc')} | ${m('commitIn')} | ${m('mkBlock')} | ${m('raft')} | ${m('toPeer')} | ${rs.map((r) => (r.ordPaired || '-')).join('/')} |`);
  }
}
