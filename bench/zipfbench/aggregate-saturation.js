#!/usr/bin/env node
'use strict';

// 포화 실험(TPS 를 올려 가며 userbench 를 돌린 것)을 한 표로 모은다.
//
//   node aggregate-saturation.js results/saturation
//
// 입력: results/saturation/tps<N>/<시스템>/u0/rep1/{meta.json, user-*.json, caliper.log, peer-commits.log}
//       results/saturation/docker-stats.log (선택: 3초마다 docker stats 를 찍은 것)
// 지표
//   목표 TPS       = meta.tps
//   보낸 TPS       = Caliper Send Rate (클라이언트가 실제로 보낸 속도)
//   블록 tx/s      = 피어가 커밋한 블록의 트랜잭션 수 / 원장 라운드 시간 (유효·무효 모두)
//   성공 TPS       = 성공 트랜잭션 / 원장 라운드 시간
//   커밋 지연      = 성공 트랜잭션의 평균 (사용자 집계)
//   CPU            = 실행 구간 동안 컨테이너별 CPU% 평균 (100% = 코어 1개). 상위 몇 개만 적는다

const fs = require('fs');
const path = require('path');
const { loadUsers } = require('./users-lib');

const root = process.argv[2];
if (!root) {
  console.error('사용법: node aggregate-saturation.js results/<폴더>');
  process.exit(1);
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function ledger(file) {
  if (!fs.existsSync(file)) return { secs: NaN, txs: 0 };
  const t = [];
  let txs = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) UTC.*Committed block \[\d+\] with (\d+) transaction/);
    if (m) { t.push(Date.parse(`${m[1]}T${m[2]}Z`)); txs += Number(m[3]); }
  }
  return { secs: t.length < 2 ? NaN : ((t[t.length - 1] - t[0]) / 1000) * t.length / (t.length - 1), txs };
}

// docker-stats.log: "T <iso>" 다음 줄들이 "<이름> <CPU%> ..." 이다
const samples = [];
const statsFile = path.join(root, 'docker-stats.log');
if (fs.existsSync(statsFile)) {
  let cur = null;
  for (const l of fs.readFileSync(statsFile, 'utf8').split('\n')) {
    if (l.startsWith('T ')) { cur = { t: Date.parse(l.slice(2)), cpu: {} }; samples.push(cur); continue; }
    const m = l.match(/^(\S+) ([\d.]+)%/);
    if (cur && m) cur.cpu[m[1]] = Number(m[2]);
  }
}
function cpuDuring(start, end) {
  const inside = samples.filter((s) => s.t >= start && s.t <= end);
  if (!inside.length) return '';
  const sum = {};
  for (const s of inside) for (const [k, v] of Object.entries(s.cpu)) sum[k] = (sum[k] || 0) + v;
  const total = Object.values(sum).reduce((a, b) => a + b, 0) / inside.length;
  const short = (n) => n.replace(/^zipfbench-/, '').replace(/\.example\.com-1$/, '').replace(/^kafka-/, '').replace(/-1$/, '');
  const top = Object.entries(sum).map(([k, v]) => [short(k), v / inside.length]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return `합 ${fmt(total, 0)}% (${top.map(([k, v]) => `${k} ${fmt(v, 0)}`).join(', ')})`;
}

// win-cpu.log (선택): "<iso> total=<PC 전체 %> vm=<VM 프로세스 %, 100 = 코어 1개>"
const winSamples = [];
for (const wf of fs.readdirSync(root).filter((f) => /^win-cpu.*\.log$/.test(f))) {
  for (const l of fs.readFileSync(path.join(root, wf), 'utf8').split('\n')) {
    const m = l.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) total=([\d.,]+) vm=([\d.,]+)/);
    if (m) winSamples.push({ t: Date.parse(m[1]), total: Number(m[2].replace(/,/g, '')), vm: Number(m[3].replace(/,/g, '')) });
  }
}
function winCpuDuring(start, end) {
  const inside = winSamples.filter((s) => s.t >= start && s.t <= end);
  if (!inside.length) return { total: NaN, vmCores: NaN, totalMax: NaN };
  return {
    total: inside.reduce((a, s) => a + s.total, 0) / inside.length,
    totalMax: Math.max(...inside.map((s) => s.total)),
    vmCores: inside.reduce((a, s) => a + s.vm, 0) / inside.length / 100,
  };
}

function findRuns(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'meta.json'))) out.push(p); else findRuns(p, out);
  }
  return out;
}

const rows = [];
for (const dir of findRuns(root)) {
  const meta = readJson(path.join(dir, 'meta.json'));
  const users = loadUsers(dir); // 워커 여럿이 나눠 보낸 사용자는 합친다
  if (!meta) continue;
  const sum = (f) => users.reduce((a, u) => a + (u.tally.all[f] || 0), 0);
  const cal = fs.existsSync(path.join(dir, 'caliper.log'))
    ? fs.readFileSync(path.join(dir, 'caliper.log'), 'utf8').split('\n').find((l) => l.startsWith('| users')) : null;
  const workers = meta.workers || 5;
  const sendRate = cal ? Number(cal.split('|').map((x) => x.trim()).filter(Boolean)[3]) : NaN;
  const lg = ledger(path.join(dir, 'peer-commits.log'));
  rows.push({
    tps: Number(meta.tps), system: meta.system, workers, sendRate,
    blockTps: lg.txs / lg.secs, successTps: sum('success') / lg.secs,
    successRate: sum('total') ? sum('success') / sum('total') : NaN,
    commitMs: sum('success') ? sum('latencySuccessSum') / sum('success') : NaN,
    cpu: cpuDuring(Date.parse(meta.start), Date.parse(meta.end)),
    win: winCpuDuring(Date.parse(meta.start), Date.parse(meta.end)),
  });
}
if (!rows.length) {
  console.error('정리할 실행이 없다:', root);
  process.exit(1);
}
rows.sort((a, b) => a.workers - b.workers || a.tps - b.tps || a.system.localeCompare(b.system));
const lines = [`# 포화 실험 (${root})`, '',
  '| 워커 | 목표 TPS | 시스템 | 보낸 TPS | 블록 tx/s | 성공 TPS | 성공률 | 커밋 지연 ms | PC 전체 CPU 평균 / 최대 | VM 프로세스 (코어) | 컨테이너 CPU 평균 (100% = 1코어) |',
  '|---|---|---|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  lines.push(`| ${r.workers} | ${r.tps} | ${r.system} | ${fmt(r.sendRate)} | ${fmt(r.blockTps)} | ${fmt(r.successTps)} | ${fmt(100 * r.successRate)}% | ${fmt(r.commitMs, 0)} | ` +
    `${fmt(r.win.total, 0)}% / ${fmt(r.win.totalMax, 0)}% | ${fmt(r.win.vmCores)} | ${r.cpu} |`);
}
fs.writeFileSync(path.join(root, 'saturation-table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
