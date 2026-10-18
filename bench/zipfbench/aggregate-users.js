#!/usr/bin/env node
'use strict';

// userbench.sh 결과를 사용자별로 정리한다 (Serializer 논문 Figure 16·Table I).
//
//   node aggregate-users.js results/<RUN_ID>
//
// 입력: results/<RUN_ID>/<시스템>/u<긴급비율>/rep<n>/{meta.json, user-User*.json}
// 출력: users-runs.csv    실행 × 사용자 한 줄씩
//       users-summary.csv 시스템 × 긴급비율 × 사용자 (반복 평균·표준편차)
//       users-table.md    사용자별 초당 성공 수와 사용자 간 표준편차 (Table I 에 해당)
//
// 지표
//   성공/s      = 사용자의 성공 트랜잭션 수 / 라운드 시간(DURATION)
//   사용자 간 표준편차 = 한 실행에서 다섯 사용자의 성공/s 의 표준편차(모표준편차)를 반복 평균한 것
//   통보 실패   = abort 토픽으로 통보받아 바로 끝난 실패 (프로세서가 버림, ABORT_NOTIFY=true)
//   느린 실패   = 커밋 대기 시간(10 s) 가까이 걸려 실패 = 블록에 들어가지 않았는데 통보도 못 받음
//   빠른 실패   = 그보다 빨리 실패 = 피어가 무효 처리 (MVCC 등)
//   커밋 지연 / abort 지연 = 보낸 뒤 사용자가 성공 / 실패를 알기까지 (논문 Fig 17(a))

const fs = require('fs');
const path = require('path');
const { loadUsers } = require('./users-lib');

const root = process.argv[2];
if (!root) {
  console.error('사용법: node aggregate-users.js results/<RUN_ID>');
  process.exit(1);
}

const SYSTEM_ORDER = ['A2', 'A1', 'FPP', 'HTF', 'B', 'BE'];
const SYSTEM_LABEL = {
  A2: 'Fabric 2.5.10',
  A1: 'Fabric (같은 소스)',
  FPP: 'Fabric++',
  HTF: 'HTFabric (WARD)',
  B: 'Serializer 변형 (SCC, 논문 아님)',
  BE: 'Serializer (논문, ε-ordering)',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function std(xs) { // 모표준편차
  if (!xs.length) return NaN;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

function sampleStd(xs) { // 반복 사이 표준편차
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

// ---- 실행 모으기 ----
const runs = [];
for (const sys of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const sysDir = path.join(root, sys);
  if (!fs.statSync(sysDir).isDirectory()) continue;
  for (const u of fs.readdirSync(sysDir)) {
    for (const rep of fs.readdirSync(path.join(sysDir, u))) {
      const dir = path.join(sysDir, u, rep);
      const meta = readJson(path.join(dir, 'meta.json'));
      if (!meta) continue;
      const users = loadUsers(dir); // 워커 여럿이 나눠 보낸 사용자는 합친다
      if (!users.length) continue;
      users.sort((a, b) => a.user.localeCompare(b.user, undefined, { numeric: true }));
      runs.push({ meta, users });
    }
  }
}
if (!runs.length) {
  console.error('정리할 실행이 없다:', root);
  process.exit(1);
}

// tx 종류(Query, 일반 쓰기, 긴급)별 결과 수와 결과를 받기까지 걸린 시간의 합
const KINDS = { query: 'Query (읽기 전용)', normalWrite: '일반 쓰기', urgent: '긴급 쓰기' };
function kindLatency(t) {
  const o = {};
  for (const k of Object.keys(KINDS)) {
    const x = t[k] || {};
    o[`${k}_success`] = x.success || 0;
    o[`${k}_latSuccessSum`] = x.latencySuccessSum || 0;
    o[`${k}_failNotified`] = x.failNotified || 0;
    o[`${k}_latNotifiedSum`] = x.latencyNotifiedSum || 0;
    o[`${k}_failFast`] = x.failFast || 0;
    o[`${k}_latFastSum`] = x.latencyFastSum || 0;
    o[`${k}_failSlow`] = x.failSlow || 0;
    o[`${k}_latSlowSum`] = x.latencySlowSum || 0;
  }
  return o;
}

// ---- 실행 × 사용자 ----
const rows = [];
for (const { meta, users } of runs) {
  for (const u of users) {
    const t = u.tally;
    rows.push({
      system: meta.system, urgentRatio: meta.urgentRatio, rep: meta.rep, user: u.user, latencyMs: u.latencyMs,
      total: t.all.total, success: t.all.success, failNotified: t.all.failNotified || 0,
      failSlow: t.all.failSlow, failFast: t.all.failFast,
      // 지연 합 (예전 결과에는 통보·빠른·느린 실패별 합이 없다)
      latSuccessSum: t.all.latencySuccessSum, latFailSum: t.all.latencyFailSum,
      latNotifiedSum: t.all.latencyNotifiedSum || 0, latFastSum: t.all.latencyFastSum,
      successPerSec: t.all.success / meta.duration,
      successRate: t.all.total ? t.all.success / t.all.total : NaN,
      urgentTotal: t.urgent.total, urgentSuccess: t.urgent.success,
      normalWriteTotal: t.normalWrite.total, normalWriteSuccess: t.normalWrite.success,
      queryTotal: t.query.total, querySuccess: t.query.success,
      avgSuccessLatencyMs: t.all.success ? t.all.latencySuccessSum / t.all.success : NaN,
      ...kindLatency(t),
    });
  }
}
const order = (a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system)
  || a.urgentRatio - b.urgentRatio || a.rep - b.rep || a.user.localeCompare(b.user, undefined, { numeric: true });
rows.sort(order);

const runCols = Object.keys(rows[0]);
fs.writeFileSync(path.join(root, 'users-runs.csv'),
  [runCols.join(',')].concat(rows.map((r) => runCols.map((c) => (typeof r[c] === 'number' ? +r[c].toFixed(4) : r[c])).join(','))).join('\n') + '\n');

// ---- 시스템 × 긴급비율 × 사용자 (반복 평균) ----
const groups = new Map();
for (const r of rows) {
  const k = `${r.system}|${r.urgentRatio}`;
  if (!groups.has(k)) groups.set(k, { system: r.system, urgentRatio: r.urgentRatio, byUser: new Map(), byRep: new Map() });
  const g = groups.get(k);
  if (!g.byUser.has(r.user)) g.byUser.set(r.user, []);
  g.byUser.get(r.user).push(r);
  if (!g.byRep.has(r.rep)) g.byRep.set(r.rep, []);
  g.byRep.get(r.rep).push(r);
}
const ordered = [...groups.values()].sort(order);

const summary = [];
for (const g of ordered) {
  for (const [user, rs] of g.byUser) {
    const m = (f) => mean(rs.map(f));
    summary.push({
      system: g.system, urgentRatio: g.urgentRatio, user, latencyMs: rs[0].latencyMs, reps: rs.length,
      successPerSec_mean: m((r) => r.successPerSec), successPerSec_std: sampleStd(rs.map((r) => r.successPerSec)),
      successRate_mean: m((r) => r.successRate),
      failSlow_mean: m((r) => r.failSlow), failFast_mean: m((r) => r.failFast),
      urgentSuccessRate: (() => {
        const tot = rs.reduce((a, r) => a + r.urgentTotal, 0);
        return tot ? rs.reduce((a, r) => a + r.urgentSuccess, 0) / tot : NaN;
      })(),
      avgSuccessLatencyMs: m((r) => r.avgSuccessLatencyMs),
    });
  }
}
const sumCols = Object.keys(summary[0]);
fs.writeFileSync(path.join(root, 'users-summary.csv'),
  [sumCols.join(',')].concat(summary.map((r) => sumCols.map((c) => (typeof r[c] === 'number' ? +r[c].toFixed(4) : r[c])).join(','))).join('\n') + '\n');

// ---- 표 (Table I) ----
const userNames = [...new Set(rows.map((r) => r.user))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const lines = [];
lines.push(`# 사용자별 성공 (${root})`, '');
lines.push(`| 시스템 | 긴급 비율 | ${userNames.join(' | ')} | 사용자 간 표준편차 | 전체 성공/s | 반복 |`);
lines.push(`|---|---|${userNames.map(() => '---').join('|')}|---|---|---|`);
for (const g of ordered) {
  const perUser = userNames.map((u) => mean((g.byUser.get(u) || []).map((r) => r.successPerSec)));
  const devs = [...g.byRep.values()].map((rs) => std(rs.map((r) => r.successPerSec)));
  const totals = [...g.byRep.values()].map((rs) => rs.reduce((a, r) => a + r.successPerSec, 0));
  lines.push(`| ${SYSTEM_LABEL[g.system] || g.system} | ${g.urgentRatio} | ${perUser.map((x) => fmt(x)).join(' | ')} | ${fmt(mean(devs), 2)} | ${fmt(mean(totals))} | ${g.byRep.size} |`);
}
lines.push('', '값은 초당 성공 트랜잭션 수(반복 평균). 사용자 지연: ' +
  userNames.map((u) => `${u} ${rows.find((r) => r.user === u).latencyMs} ms`).join(', ') + '.');

lines.push('', '## 긴급 트랜잭션 (User3)', '');
lines.push('| 시스템 | 긴급 비율 | 긴급 성공률 | User3 일반 쓰기 성공률 | 다른 사용자 쓰기 성공률 |', '|---|---|---|---|---|');
for (const g of ordered) {
  if (!g.urgentRatio) continue;
  const all = [...g.byUser.values()].flat();
  const u3 = all.filter((r) => r.user === 'User3');
  const others = all.filter((r) => r.user !== 'User3');
  const rate = (rs, s, t) => {
    const tot = rs.reduce((a, r) => a + r[t], 0);
    return tot ? rs.reduce((a, r) => a + r[s], 0) / tot : NaN;
  };
  lines.push(`| ${SYSTEM_LABEL[g.system] || g.system} | ${g.urgentRatio} | ${fmt(100 * rate(u3, 'urgentSuccess', 'urgentTotal'))}% | ` +
    `${fmt(100 * rate(u3, 'normalWriteSuccess', 'normalWriteTotal'))}% | ${fmt(100 * rate(others, 'normalWriteSuccess', 'normalWriteTotal'))}% |`);
}

lines.push('', '## 실패 내역 (실행당 평균, 다섯 사용자 합)', '');
lines.push('| 시스템 | 긴급 비율 | 성공 | 통보 실패 (프로세서가 버림, 바로 앎) | 느린 실패 (버려졌지만 통보 없음) | 빠른 실패 (피어 무효) |',
  '|---|---|---|---|---|---|');
for (const g of ordered) {
  const reps = [...g.byRep.values()];
  const s = (f) => mean(reps.map((rs) => rs.reduce((a, r) => a + r[f], 0)));
  lines.push(`| ${SYSTEM_LABEL[g.system] || g.system} | ${g.urgentRatio} | ${fmt(s('success'), 0)} | ${fmt(s('failNotified'), 0)} | ${fmt(s('failSlow'), 0)} | ${fmt(s('failFast'), 0)} |`);
}

// 논문 Fig 17(a): 사용자가 결과를 알기까지의 시간 (보내기 전 사용자 지연은 빼고 잰 값)
lines.push('', '## 커밋 지연과 abort 지연 (ms, 모든 트랜잭션 평균)', '');
lines.push('| 시스템 | 긴급 비율 | 커밋 지연 | abort 지연 (전체 실패) | 통보 실패 | 빠른 실패 |', '|---|---|---|---|---|---|');
for (const g of ordered) {
  const all = [...g.byUser.values()].flat();
  const avg = (sum, cnt) => {
    const c = all.reduce((a, r) => a + r[cnt], 0);
    return c ? all.reduce((a, r) => a + r[sum], 0) / c : NaN;
  };
  all.forEach((r) => { r.failAll = r.failNotified + r.failSlow + r.failFast; });
  lines.push(`| ${SYSTEM_LABEL[g.system] || g.system} | ${g.urgentRatio} | ${fmt(avg('latSuccessSum', 'success'), 0)} | ` +
    `${fmt(avg('latFailSum', 'failAll'), 0)} | ${fmt(avg('latNotifiedSum', 'failNotified'), 0)} | ${fmt(avg('latFastSum', 'failFast'), 0)} |`);
}
// 같은 지연을 tx 종류별로 나눈다. 칸은 "평균 ms (건수/실행)". 실패 = 통보 + 빠른 + 느린 실패.
lines.push('', '## 결과를 받기까지 걸린 시간, tx 종류별 (ms, 괄호는 실행당 건수)', '');
lines.push('| 시스템 | 긴급 비율 | 종류 | 성공 | 실패 전체 | 통보 실패 | 빠른 실패 (피어 무효) | 느린 실패 |', '|---|---|---|---|---|---|---|---|');
for (const g of ordered) {
  const all = [...g.byUser.values()].flat();
  const nRep = g.byRep.size;
  const sum = (f) => all.reduce((a, r) => a + r[f], 0);
  const cell = (latF, cntF) => {
    const lat = [].concat(latF).reduce((a, f) => a + sum(f), 0);
    const cnt = [].concat(cntF).reduce((a, f) => a + sum(f), 0);
    return cnt ? `${fmt(lat / cnt, 0)} (${fmt(cnt / nRep, 0)})` : '-';
  };
  for (const k of Object.keys(KINDS)) {
    if (!sum(`${k}_success`) && !sum(`${k}_failNotified`) && !sum(`${k}_failFast`) && !sum(`${k}_failSlow`)) continue;
    lines.push(`| ${SYSTEM_LABEL[g.system] || g.system} | ${g.urgentRatio} | ${KINDS[k]} | ${cell(`${k}_latSuccessSum`, `${k}_success`)} | ` +
      `${cell([`${k}_latNotifiedSum`, `${k}_latFastSum`, `${k}_latSlowSum`], [`${k}_failNotified`, `${k}_failFast`, `${k}_failSlow`])} | ` +
      `${cell(`${k}_latNotifiedSum`, `${k}_failNotified`)} | ${cell(`${k}_latFastSum`, `${k}_failFast`)} | ${cell(`${k}_latSlowSum`, `${k}_failSlow`)} |`);
  }
}
fs.writeFileSync(path.join(root, 'users-table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
