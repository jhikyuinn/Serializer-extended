#!/usr/bin/env node
'use strict';
// bench.sh 결과 폴더를 정리한다.
//
//   node aggregate.js results/<RUN_ID>
//
// 만드는 것 (같은 폴더에)
//   runs.csv          실행 하나당 한 줄
//   summary.csv       시스템 × s 별 평균과 표준편차 (반복 횟수 n)
//   block-delay.svg   s 에 따른 블록 처리 지연
//   committed-tps.svg s 에 따른 Committed TPS
//   overall-tps.svg   s 에 따른 Overall TPS
//
// 지표 정의
//   roundTime     = (Succ + Fail) / Caliper Throughput
//                   (Caliper 0.6 의 Throughput 은 끝난 트랜잭션 전체(Succ+Fail)를 라운드 시간으로 나눈 값이다)
//   committedTps  = Succ / roundTime
//   mvcc          = 피어 ledger_transaction_count{validation_code="MVCC_READ_CONFLICT"} 의 증가분 (Org1 피어)
//   dropped       = B 에서 프로세서가 버린 트랜잭션 수 (processor.log 의 "ABORT tx" 줄)
//   conflictFail  = mvcc + dropped                  (충돌 때문에 실패한 것만)
//   otherFail     = max(0, Fail - conflictFail)     (타임아웃, 보증 실패 등. Overall TPS 에 넣지 않는다)
//   overallTps    = (Succ + conflictFail) / roundTime
//   peerBlockMs   = ledger_block_processing_time 의 증가분 합/개수 (두 피어 평균), ms
//   reorderMs     = B 에서 배치당 재정렬 시간 평균 ([Total Ordering Time], ms). A 는 0
//   blockDelayMs  = peerBlockMs + reorderMs

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) {
  console.error('사용법: node aggregate.js results/<RUN_ID>');
  process.exit(1);
}

const SYSTEM_ORDER = ['B', 'BE', 'FPP', 'HTF', 'A1', 'A2'];
const SYSTEM_LABEL = {
  B: 'B: Fabric + 재정렬 (Serializer 변형, SCC)',
  BE: 'BE: Fabric + 재정렬 (Serializer, 논문 ε-ordering)',
  FPP: 'FPP: Fabric + 재정렬 (Fabric++)',
  HTF: 'HTF: Fabric + 재정렬 (HTFabric, WARD)',
  A1: 'A1: Fabric (같은 소스)',
  A2: 'A2: Fabric 2.5.10 공식',
};
// Kafka 프로세서를 거치는 시스템 (같은 네트워크, 정렬 알고리즘만 다르다)
const PROCESSOR_SYSTEMS = new Set(['B', 'BE', 'FPP', 'HTF']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Prometheus 스냅샷에서 이름·라벨 조건에 맞는 값을 인스턴스별로 꺼낸다
function promValues(snap, name, match = {}) {
  const out = {};
  if (!snap || !snap.data) return out;
  for (const r of snap.data.result) {
    if (r.metric.__name__ !== name) continue;
    let ok = true;
    for (const [k, v] of Object.entries(match)) {
      const actual = r.metric[k] || '';
      if (v instanceof RegExp ? !v.test(actual) : actual !== v) ok = false;
    }
    if (!ok) continue;
    out[r.metric.instance] = (out[r.metric.instance] || 0) + Number(r.value[1]);
  }
  return out;
}

function delta(before, after, name, match) {
  const b = promValues(before, name, match);
  const a = promValues(after, name, match);
  const d = {};
  for (const inst of Object.keys(a)) d[inst] = a[inst] - (b[inst] || 0);
  return d;
}

function parseCaliper(file) {
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('| transfer'));
  if (!line) return null;
  const c = line.split('|').map((x) => x.trim()).filter((x) => x !== '');
  // Name | Succ | Fail | Send Rate | Max | Min | Avg Latency | Throughput
  return {
    succ: Number(c[1]), fail: Number(c[2]), sendRate: Number(c[3]),
    maxLat: Number(c[4]), minLat: Number(c[5]), avgLat: Number(c[6]), throughput: Number(c[7]),
  };
}

function parseProcessor(file) {
  if (!fs.existsSync(file)) return { batches: 0, reorderMs: 0, dropped: 0 };
  // 버린 수는 알고리즘과 무관한 [Batch] 줄(aborted=)로 센다. 그 줄이 없는 예전 로그는
  // Serializer 만 찍던 "ABORT tx" 줄로 센다.
  let sum = 0, n = 0, abortLines = 0, batchAborted = 0, batchLines = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/^\[Total Ordering Time\]\s+(\d+)/);
    if (m) { sum += Number(m[1]); n++; }
    if (l.startsWith('ABORT tx')) abortLines++;
    const b = l.match(/^\[Batch\] n=\d+ ordered=\d+ aborted=(\d+)/);
    if (b) { batchAborted += Number(b[1]); batchLines++; }
  }
  return { batches: n, reorderMs: n ? sum / n : 0, dropped: batchLines ? batchAborted : abortLines };
}

// 피어 로그의 "Committed block [n] with m transaction(s)" 시각으로 라운드가 원장에 반영된 시간을 잰다.
// 블록 n 개의 처음~끝 간격에 n/(n-1) 을 곱해 블록 하나 분의 간격을 더한다.
function parsePeerCommits(file) {
  if (!fs.existsSync(file)) return { ledgerRoundTime: NaN, ledgerBlocks: 0, ledgerTx: 0 };
  const times = [];
  let txs = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) UTC.*Committed block \[\d+\] with (\d+) transaction/);
    if (!m) continue;
    times.push(Date.parse(`${m[1]}T${m[2]}Z`));
    txs += Number(m[3]);
  }
  if (times.length < 2) return { ledgerRoundTime: NaN, ledgerBlocks: times.length, ledgerTx: txs };
  const span = (times[times.length - 1] - times[0]) / 1000;
  return { ledgerRoundTime: (span * times.length) / (times.length - 1), ledgerBlocks: times.length, ledgerTx: txs };
}

function findRuns(dir) {
  const runs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'meta.json') runs.push(d);
    }
  };
  walk(dir);
  return runs;
}

const rows = [];
for (const dir of findRuns(root)) {
  const meta = readJson(path.join(dir, 'meta.json'));
  const cal = parseCaliper(path.join(dir, 'caliper.log'));
  if (!meta || !cal) {
    console.warn('건너뜀 (결과 불완전):', dir);
    continue;
  }
  const before = readJson(path.join(dir, 'prom-before.json'));
  const after = readJson(path.join(dir, 'prom-after.json'));

  const zipfCc = /^zipf/;
  const mvccByPeer = delta(before, after, 'ledger_transaction_count', { validation_code: 'MVCC_READ_CONFLICT', chaincode: zipfCc });
  const validByPeer = delta(before, after, 'ledger_transaction_count', { validation_code: 'VALID', chaincode: zipfCc });
  const sumByPeer = delta(before, after, 'ledger_block_processing_time_sum');
  const cntByPeer = delta(before, after, 'ledger_block_processing_time_count');

  const org1 = Object.keys(mvccByPeer).concat(Object.keys(validByPeer)).find((k) => k.startsWith('peer0.org1')) || 'peer0.org1.example.com:9443';
  const mvcc = mvccByPeer[org1] || 0;
  const valid = validByPeer[org1] || 0;
  const perPeer = Object.keys(cntByPeer).filter((k) => cntByPeer[k] > 0).map((k) => sumByPeer[k] / cntByPeer[k]);
  const peerBlockMs = perPeer.length ? (1000 * perPeer.reduce((a, b) => a + b, 0)) / perPeer.length : NaN;
  const blocks = cntByPeer[org1] || 0;

  const proc = PROCESSOR_SYSTEMS.has(meta.system) ? parseProcessor(path.join(dir, 'processor.log')) : { batches: 0, reorderMs: 0, dropped: 0 };

  const total = cal.succ + cal.fail;
  const roundTime = cal.throughput > 0 ? total / cal.throughput : NaN;
  const conflictFail = mvcc + proc.dropped;
  const otherFail = Math.max(0, cal.fail - conflictFail);
  const ledger = parsePeerCommits(path.join(dir, 'peer-commits.log'));

  rows.push({
    system: meta.system, s: meta.s, rep: meta.rep,
    succ: cal.succ, fail: cal.fail, sendRate: cal.sendRate, throughput: cal.throughput, avgLatency: cal.avgLat,
    ledgerRoundTime: ledger.ledgerRoundTime, ledgerBlocks: ledger.ledgerBlocks, ledgerTx: ledger.ledgerTx,
    committedTps: cal.succ / ledger.ledgerRoundTime, overallTps: (cal.succ + conflictFail) / ledger.ledgerRoundTime,
    roundTime, committedTpsCaliper: cal.succ / roundTime, overallTpsCaliper: (cal.succ + conflictFail) / roundTime,
    mvcc, dropped: proc.dropped, conflictFail, otherFail, validOnPeer: valid, blocks,
    peerBlockMs, reorderMs: proc.reorderMs, reorderBatches: proc.batches, blockDelayMs: peerBlockMs + proc.reorderMs,
  });
}

if (!rows.length) {
  console.error('정리할 실행이 없다:', root);
  process.exit(1);
}

rows.sort((a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system) || a.s - b.s || a.rep - b.rep);

const fmt = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '') : String(v));
function writeCsv(file, data) {
  const cols = Object.keys(data[0]);
  const text = [cols.join(',')].concat(data.map((r) => cols.map((c) => fmt(r[c])).join(','))).join('\n') + '\n';
  fs.writeFileSync(file, text);
}
writeCsv(path.join(root, 'runs.csv'), rows);

// ---- 시스템 × s 별 평균, 표준편차 ----
const METRICS = ['blockDelayMs', 'peerBlockMs', 'reorderMs', 'committedTps', 'overallTps', 'committedTpsCaliper', 'overallTpsCaliper',
  'ledgerRoundTime', 'roundTime', 'throughput', 'succ', 'fail', 'mvcc', 'dropped', 'otherFail', 'avgLatency'];
const groups = new Map();
for (const r of rows) {
  const key = `${r.system}|${r.s}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const summary = [];
for (const [key, rs] of groups) {
  const [system, s] = key.split('|');
  const row = { system, s: Number(s), n: rs.length };
  for (const m of METRICS) {
    const xs = rs.map((r) => r[m]).filter(Number.isFinite);
    row[`${m}_mean`] = xs.length ? mean(xs) : NaN;
    row[`${m}_std`] = xs.length ? std(xs) : NaN;
  }
  summary.push(row);
}
summary.sort((a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system) || a.s - b.s);
writeCsv(path.join(root, 'summary.csv'), summary);

// ---- SVG 그래프 ----
// 범주 색은 고정 순서 (B 파랑, FPP 보라, HTF 자홍, A1 주황, A2 청록). 선 2px, 점 8px, 오차 막대 = ±표준편차.
const COLORS = { B: '#2a78d6', BE: '#0f8b8d', FPP: '#8b5cf6', HTF: '#d6336c', A1: '#eb6834', A2: '#1baf7a' };
const INK = '#0b0b0b', INK2 = '#52514e', GRID = '#e4e3df', SURFACE = '#fcfcfb';

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function chart(file, metric, title, yLabel) {
  const W = 720, H = 440, L = 72, R = 200, T = 56, B = 56;
  const pw = W - L - R, ph = H - T - B;
  const systems = SYSTEM_ORDER.filter((s) => summary.some((r) => r.system === s));
  const sVals = [...new Set(summary.map((r) => r.s))].sort((a, b) => a - b);
  const xMin = Math.min(...sVals), xMax = Math.max(...sVals);
  let yTop = 0;
  for (const r of summary) {
    const v = r[`${metric}_mean`] + (r[`${metric}_std`] || 0);
    if (Number.isFinite(v)) yTop = Math.max(yTop, v);
  }
  yTop = niceMax(yTop * 1.05);
  const x = (s) => L + (xMax === xMin ? pw / 2 : ((s - xMin) / (xMax - xMin)) * pw);
  const y = (v) => T + ph - (v / yTop) * ph;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', 'Malgun Gothic', sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
  out.push(`<text x="${L}" y="28" font-size="16" font-weight="600" fill="${INK}">${title}</text>`);
  // 가로 격자와 y 눈금
  for (let i = 0; i <= 5; i++) {
    const v = (yTop * i) / 5;
    out.push(`<line x1="${L}" x2="${L + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${L - 8}" y="${y(v) + 4}" font-size="12" text-anchor="end" fill="${INK2}" style="font-variant-numeric: tabular-nums">${Math.round(v * 100) / 100}</text>`);
  }
  // x 눈금 (실험한 s 값)
  for (const s of sVals) {
    out.push(`<line x1="${x(s)}" x2="${x(s)}" y1="${T + ph}" y2="${T + ph + 4}" stroke="${INK2}"/>`);
    out.push(`<text x="${x(s)}" y="${T + ph + 18}" font-size="11" text-anchor="middle" fill="${INK2}">${s}</text>`);
  }
  out.push(`<line x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}" stroke="${INK2}" stroke-width="1"/>`);
  out.push(`<text x="${L + pw / 2}" y="${H - 14}" font-size="13" text-anchor="middle" fill="${INK}">Zipf 지수 s</text>`);
  out.push(`<text transform="translate(18 ${T + ph / 2}) rotate(-90)" font-size="13" text-anchor="middle" fill="${INK}">${yLabel}</text>`);

  systems.forEach((sys, idx) => {
    const pts = summary.filter((r) => r.system === sys && Number.isFinite(r[`${metric}_mean`])).sort((a, b) => a.s - b.s);
    if (!pts.length) return;
    const c = COLORS[sys];
    out.push(`<polyline fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" points="${pts.map((p) => `${x(p.s)},${y(p[`${metric}_mean`])}`).join(' ')}"/>`);
    for (const p of pts) {
      const m = p[`${metric}_mean`], sd = p[`${metric}_std`] || 0;
      if (sd > 0) {
        out.push(`<line x1="${x(p.s)}" x2="${x(p.s)}" y1="${y(m + sd)}" y2="${y(Math.max(0, m - sd))}" stroke="${c}" stroke-width="1.5"/>`);
      }
      out.push(`<circle cx="${x(p.s)}" cy="${y(m)}" r="4" fill="${c}" stroke="${SURFACE}" stroke-width="2"><title>${SYSTEM_LABEL[sys]} s=${p.s}: ${Math.round(m * 100) / 100} ± ${Math.round(sd * 100) / 100} (n=${p.n})</title></circle>`);
    }
    // 범례 (오른쪽)
    const ly = T + 8 + idx * 24;
    out.push(`<line x1="${L + pw + 20}" x2="${L + pw + 40}" y1="${ly}" y2="${ly}" stroke="${c}" stroke-width="2"/>`);
    out.push(`<circle cx="${L + pw + 30}" cy="${ly}" r="4" fill="${c}"/>`);
    out.push(`<text x="${L + pw + 48}" y="${ly + 4}" font-size="12" fill="${INK}">${SYSTEM_LABEL[sys]}</text>`);
  });
  out.push(`<text x="${L + pw + 20}" y="${T + 8 + systems.length * 24 + 10}" font-size="11" fill="${INK2}">점 = 평균, 막대 = ±표준편차</text>`);
  out.push('</svg>');
  fs.writeFileSync(path.join(root, file), out.join('\n') + '\n');
}

chart('block-delay.svg', 'blockDelayMs', '블록 처리 지연 (B 는 재정렬 시간 포함)', 'ms / 블록');
chart('committed-tps.svg', 'committedTps', 'Committed TPS (원장 기준 라운드 시간)', 'TPS');
chart('overall-tps.svg', 'overallTps', 'Overall TPS = (Succ + 충돌 실패) / 원장 기준 라운드 시간', 'TPS');
// Caliper 의 라운드 시간은 B 에서 프로세서가 버린 트랜잭션의 타임아웃(10s)까지 포함한다
chart('committed-tps-caliper.svg', 'committedTpsCaliper', 'Committed TPS (Caliper 라운드 시간)', 'TPS');
chart('overall-tps-caliper.svg', 'overallTpsCaliper', 'Overall TPS (Caliper 라운드 시간)', 'TPS');

// 화면 요약
console.log('system   s     n  blockDelayMs  reorderMs  committedTps  overallTps  ledgerRound  caliperRound  succ   mvcc  dropped  otherFail');
for (const r of summary) {
  const f = (m, w) => fmt(r[`${m}_mean`]).padStart(w);
  console.log(`${r.system.padEnd(6)} ${String(r.s).padStart(4)} ${String(r.n).padStart(3)} ${f('blockDelayMs', 13)} ${f('reorderMs', 10)} ${f('committedTps', 13)} ${f('overallTps', 11)} ${f('ledgerRoundTime', 12)} ${f('roundTime', 13)} ${f('succ', 6)} ${f('mvcc', 6)} ${f('dropped', 8)} ${f('otherFail', 10)}`);
}
console.log(`\n${path.join(root, 'runs.csv')}, summary.csv, *.svg`);
