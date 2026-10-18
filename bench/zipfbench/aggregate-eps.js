#!/usr/bin/env node
'use strict';

// ε 격자 실험(userbench.sh 를 EPS_URGENT × EPS_LOW 마다 RUN_ID=<상위>/u<εu>-l<εl> 로 돌린 것)을 한 표로 모은다.
// 논문 Fig 14 처럼 ε 에 따른 성공·지연·정렬 시간과, Table I 처럼 사용자 간 공정성을 함께 본다.
//
//   node aggregate-eps.js results/epsgrid
//
// 출력: eps-summary.csv, eps-table.md (상위 폴더에)
//
// 지표
//   성공 TPS      = 다섯 사용자의 성공 합 / 원장 라운드 시간 (피어 "Committed block" 첫~끝)
//   사용자 간 표준편차 = 사용자별 성공/s(라운드 30 초 기준)의 모표준편차
//   긴급 성공률   = User3 긴급 트랜잭션 중 성공 비율, 다른 사용자 = User3 외 사용자의 쓰기 성공 비율
//   정렬 시간     = 프로세서 [Timing] 의 sched (배치당 정렬 함수 시간, ms) 평균
//   abort 지연    = 실패를 아는 데 걸린 시간 평균 (통보·빠른·느린 실패 모두)

const fs = require('fs');
const path = require('path');
const { loadUsers } = require('./users-lib');

const root = process.argv[2];
if (!root) {
  console.error('사용법: node aggregate-eps.js results/<상위 폴더>');
  process.exit(1);
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function ledgerSeconds(file) {
  if (!fs.existsSync(file)) return NaN;
  const t = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) UTC.*Committed block/);
    if (m) t.push(Date.parse(`${m[1]}T${m[2]}Z`));
  }
  return t.length < 2 ? NaN : ((t[t.length - 1] - t[0]) / 1000) * t.length / (t.length - 1);
}

function schedMs(file) {
  if (!fs.existsSync(file)) return NaN;
  const xs = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/^\[Timing\] n=(\d+) .* sched=([\d.]+)/);
    if (m && Number(m[1]) > 1) xs.push(Number(m[2]));
  }
  return mean(xs);
}

// root 아래에서 meta.json 이 있는 실행 폴더를 모두 찾는다
function findRuns(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'meta.json'))) out.push(p);
    else findRuns(p, out);
  }
  return out;
}

const rows = [];
for (const dir of findRuns(root)) {
  const meta = readJson(path.join(dir, 'meta.json'));
  const users = loadUsers(dir); // 워커 여럿이 나눠 보낸 사용자는 합친다
  if (!meta || !users.length) continue;
  const sum = (f) => users.reduce((a, u) => a + (u.tally.all[f] || 0), 0);
  const perUser = users.map((u) => u.tally.all.success / meta.duration);
  const m = mean(perUser);
  const u3 = users.find((u) => u.user === 'User3');
  const others = users.filter((u) => u.user !== 'User3');
  const writeOk = others.reduce((a, u) => a + u.tally.normalWrite.success + u.tally.urgent.success, 0);
  const writeAll = others.reduce((a, u) => a + u.tally.normalWrite.total + u.tally.urgent.total, 0);
  const fails = sum('failNotified') + sum('failFast') + sum('failSlow');
  rows.push({
    system: meta.system, epsUrgent: Number(meta.epsUrgent), epsLow: Number(meta.epsLow), urgentRatio: meta.urgentRatio, rep: meta.rep,
    successTps: sum('success') / ledgerSeconds(path.join(dir, 'peer-commits.log')),
    userStd: Math.sqrt(mean(perUser.map((x) => (x - m) * (x - m)))),
    urgentSuccessRate: u3 && u3.tally.urgent.total ? u3.tally.urgent.success / u3.tally.urgent.total : NaN,
    otherWriteSuccessRate: writeAll ? writeOk / writeAll : NaN,
    success: sum('success'), failNotified: sum('failNotified'), failFast: sum('failFast'), failSlow: sum('failSlow'),
    commitLatencyMs: sum('success') ? sum('latencySuccessSum') / sum('success') : NaN,
    abortLatencyMs: fails ? sum('latencyFailSum') / fails : NaN,
    schedMs: schedMs(path.join(dir, 'processor.log')),
  });
}
if (!rows.length) {
  console.error('정리할 실행이 없다:', root);
  process.exit(1);
}
rows.sort((a, b) => a.system.localeCompare(b.system) || a.epsUrgent - b.epsUrgent || a.epsLow - b.epsLow || a.rep - b.rep);

const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(root, 'eps-summary.csv'),
  [cols.join(',')].concat(rows.map((r) => cols.map((c) => (typeof r[c] === 'number' ? +r[c].toFixed(4) : r[c])).join(','))).join('\n') + '\n');

// 같은 (εu, εl) 의 반복은 평균한다
const groups = new Map();
for (const r of rows) {
  const k = `${r.system}|${r.epsUrgent}|${r.epsLow}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const lines = [`# ε 격자 (${root})`, '',
  '| 시스템 | ε_urgent | ε_low | 성공 TPS | 사용자 간 표준편차 | 긴급 성공률 | 다른 사용자 쓰기 성공률 | 통보 실패 | 빠른 실패 | 커밋 지연 ms | abort 지연 ms | 정렬 ms/배치 | 반복 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
for (const rs of groups.values()) {
  const a = (f) => mean(rs.map((r) => r[f]));
  lines.push(`| ${rs[0].system} | ${rs[0].epsUrgent} | ${rs[0].epsLow} | ${fmt(a('successTps'))} | ${fmt(a('userStd'), 2)} | ${fmt(100 * a('urgentSuccessRate'))}% | ` +
    `${fmt(100 * a('otherWriteSuccessRate'))}% | ${fmt(a('failNotified'), 0)} | ${fmt(a('failFast'), 0)} | ${fmt(a('commitLatencyMs'), 0)} | ` +
    `${fmt(a('abortLatencyMs'), 0)} | ${fmt(a('schedMs'), 2)} | ${rs.length} |`);
}
fs.writeFileSync(path.join(root, 'eps-table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
