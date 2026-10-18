'use strict';

// 사용자 실험 결과(user-*.json)를 읽어 사용자별로 합친다.
// 워커 하나가 사용자 하나이던 예전 결과(user-<사용자>.json)와, 사용자 하나를 워커 여럿이 나눠 보낸
// 결과(user-<사용자>-w<워커>.json) 를 같은 모양({user, latencyMs, urgentRatio, ops, tally, workers})으로 돌려준다.

const fs = require('fs');
const path = require('path');

function addInto(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v === 'number') dst[k] = (dst[k] || 0) + v;
    else if (v && typeof v === 'object') addInto(dst[k] || (dst[k] = {}), v);
  }
}

function loadUsers(dir) {
  const byUser = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /^user-.*\.json$/.test(x))) {
    let u;
    try {
      u = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      continue;
    }
    if (!byUser.has(u.user)) {
      byUser.set(u.user, { user: u.user, latencyMs: u.latencyMs, urgentRatio: u.urgentRatio, ops: {}, tally: {}, workers: 0 });
    }
    const m = byUser.get(u.user);
    addInto(m.ops, u.ops);
    addInto(m.tally, u.tally);
    m.workers++;
  }
  return [...byUser.values()].sort((a, b) => a.user.localeCompare(b.user, undefined, { numeric: true }));
}

module.exports = { loadUsers };
