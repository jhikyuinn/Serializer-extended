// 활성 s-node를 멈춘 뒤 새 커미티가 w-node에 적용되기까지의 시간(인계 시간)을 잰다.
//
//   node failover.js <설정 폴더> [<설정 폴더> ...]
//
// run.sh를 FREEZE_ACTIVE_EVERY로 돌린 결과에 쓴다. analyze.js가 만든 rounds.csv가 있으면
// 멈춘 라운드와 그 뒤 두 라운드의 지연도 함께 보여 준다.
const fs = require('fs');
const path = require('path');

const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean) : []);

for (const dir of process.argv.slice(2)) {
  // 커미티가 적용된 시각: 노드마다 조금씩 다르므로 가장 이른 시각을 쓴다
  const applied = new Map(); // 커미티 라운드 번호 -> 시각(ms)
  for (const f of fs.readdirSync(dir).filter((x) => /^bz\d+\.log$/.test(x))) {
    for (const l of lines(path.join(dir, f))) {
      const m = l.match(/^(\S+?)(\.\d+)?Z .*CommitteeMsg Round: (\d+)/);
      if (!m) continue;
      const at = Date.parse(m[1] + (m[2] || '').slice(0, 4) + 'Z');
      if (!applied.has(m[3]) || at < applied.get(m[3])) applied.set(m[3], at);
    }
  }
  const committees = [...applied.values()].sort((a, b) => a - b);

  const latency = new Map();
  for (const l of lines(path.join(dir, 'rounds.csv')).slice(1)) {
    const c = l.split(',');
    latency.set(Number(c[0]), c[2] === '' ? Infinity : Number(c[2]) / 1000);
  }

  const events = lines(path.join(dir, 'events.csv')).slice(1).map((l) => {
    const [round, at, , active, frozen] = l.split(',');
    return { round: Number(round), at: Number(at), active: active || '', frozen: frozen || '' };
  });

  const times = [];
  console.log(`\n${dir}`);
  console.log('round  takeover_s  latency of this round and the next two (s)');
  events.forEach((e, i) => {
    const name = e.active.split(';')[0];
    const prev = i > 0 ? events[i - 1].frozen : '';
    if (!name || !e.frozen.includes(name) || prev.includes(name)) return; // 활성 pod를 새로 멈춘 라운드만
    const next = committees.find((t) => t > e.at + 500);
    const t = next === undefined ? Infinity : (next - e.at) / 1000;
    times.push(t);
    const lat = [0, 1, 2].map((k) => {
      const v = latency.get(e.round + k);
      return v === undefined ? '-' : v.toFixed(1);
    });
    console.log(`${String(e.round).padStart(5)}  ${t.toFixed(1).padStart(10)}  ${lat.join('  ')}`);
  });
  if (times.length) {
    const s = [...times].sort((a, b) => a - b);
    console.log(`takeovers=${s.length}  min=${s[0].toFixed(1)}  median=${s[Math.floor(s.length / 2)].toFixed(1)}  ` +
      `max=${s[s.length - 1].toFixed(1)}  within 10s: ${s.filter((x) => x <= 10).length}/${s.length}`);
  }
}
