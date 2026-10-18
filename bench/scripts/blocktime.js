// 블록마다 처리 시간 분해 (§57). 오더러·피어가 같은 VM 이라 시계가 같다.
//   Serializer: Kafka 전송 확인(배치 확정) → 블록 생성 = 정렬 왕복
//   공통: 블록 생성 → 피어 수신(커밋 끝 − 피어 커밋 시간) = 블록 쓰기·전달, 피어 커밋 시간 = 검증·커밋
// 정상 구간: tx 10건 이상 블록이 처음 나온 시각 + 앞 5초 ~ 실행 길이까지
const fs = require('fs'), path = require('path');
const ts = (s) => Date.parse(s.replace(' UTC', 'Z').replace(' ', 'T'));
function blockTimes(dir) {
  const ol = fs.readFileSync(path.join(dir, 'orderer.log'), 'utf8').split('\n');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
  const created = {}, sent = {}; let lastSend = null;
  for (const l of ol) {
    const t = Date.parse(l.slice(0, 30).trim().split(' ')[0]);
    if (/Delivered message to topic/.test(l)) lastSend = t;
    const m = l.match(/Created block \[(\d+)\]/);
    if (m) { created[+m[1]] = t; if (lastSend != null) { sent[+m[1]] = lastSend; lastSend = null; } }
  }
  const rows = [];
  for (const l of fs.readFileSync(path.join(dir, 'peer-commits.log'), 'utf8').split('\n')) {
    const m = l.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) UTC.*Committed block \[(\d+)\] with (\d+) transaction\(s\) in (\d+)ms/);
    if (!m) continue;
    const b = +m[2], end = ts(m[1] + ' UTC'), dur = +m[4], n = +m[3];
    if (created[b] == null) continue;
    rows.push({ b, n, created: created[b], sent: sent[b], end, dur });
  }
  const loaded = rows.filter((r) => r.n >= 10);
  if (!loaded.length) return null;
  const t0 = loaded[0].created + (meta.warmupSec || 0) * 1000, t1 = loaded[0].created + meta.duration * 1000;
  const w = rows.filter((r) => r.created >= t0 && r.created <= t1 && r.n >= 1);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const gaps = []; for (let i = 1; i < w.length; i++) gaps.push(w[i].created - w[i - 1].created);
  return {
    blocks: w.length, tx: mean(w.map((r) => r.n)),
    order: w[0].sent != null ? mean(w.filter((r) => r.sent != null).map((r) => r.created - r.sent)) : 0,
    deliver: mean(w.map((r) => r.end - r.dur - r.created)),
    commit: mean(w.map((r) => r.dur)),
    interval: mean(gaps),
  };
}
module.exports = { blockTimes };
if (require.main === module) for (const d of process.argv.slice(2)) console.log(d, JSON.stringify(blockTimes(d)));
