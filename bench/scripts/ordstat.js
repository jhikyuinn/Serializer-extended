// §67 오더러 계측 요약: orderer.log 의 [ORDSTAT](초마다)와 [ORDBATCH](배치마다)
//   node ordstat.js <실행 폴더>...   (실행 폴더 = .../BE/u0/rep1 처럼 orderer.log 가 있는 곳)
// 정상 구간: recv 가 처음 0 보다 커진 초부터 앞 WARM 초(기본 5)를 버리고, recv 가 마지막으로 0 보다 큰 초까지
const fs = require('fs'), path = require('path');
const WARM = +(process.env.WARM || 5);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const num = (s, k) => { const m = s.match(new RegExp(`\\b${k}=([\\d.]+)`)); return m ? +m[1] : NaN; };
for (const dir of process.argv.slice(2)) {
  const lines = fs.readFileSync(path.join(dir, 'orderer.log'), 'utf8').split('\n');
  const st = lines.filter((l) => l.includes('[ORDSTAT]')).map((l) => Object.fromEntries(
    ['t', 'recv', 'submitN', 'submitWaitAvg', 'submitWaitMax', 'ordered', 'propose', 'idleOpen', 'idlePaused', 'batches'].map((k) => [k, num(l, k)])));
  const first = st.findIndex((r) => r.recv > 0), last = st.length - 1 - [...st].reverse().findIndex((r) => r.recv > 0);
  const w = first < 0 ? [] : st.slice(first + WARM, last); // 마지막 초는 부분 구간이라 뺀다
  const bt = lines.filter((l) => l.includes('[ORDBATCH]')).map((l) => Object.fromEntries(
    ['n', 'cut', 'extract', 'marshal', 'produce', 'wait', 'create'].map((k) => [k, num(l, k)])));
  const t0 = w.length ? w[0].t - 1000 : 0, t1 = w.length ? w[w.length - 1].t : 0;
  const bw = bt.filter((b) => b.cut >= t0 && b.cut <= t1);
  const gaps = []; for (let i = 1; i < bw.length; i++) gaps.push(bw[i].cut - bw[i - 1].cut);
  const f = (k, d = 1) => mean(w.map((r) => r[k])).toFixed(d);
  const g = (k, d = 2) => mean(bw.map((r) => r[k])).toFixed(d);
  console.log(`${dir}\n  초 ${w.length}개 · 받은 tx/s ${f('recv', 0)} · Submit 대기 평균 ${f('submitWaitAvg', 2)} ms (초별 최대의 평균 ${f('submitWaitMax', 1)})`);
  console.log(`  run loop 1초 중(ms): tx 처리 ${f('ordered')} · propose ${f('propose')} · 받을 수 있는데 빈 시간 ${f('idleOpen')} · 받지 않는 상태 ${f('idlePaused')}`);
  console.log(`  배치 ${bw.length}개 (평균 ${g('n', 0)} tx, 간격 ${mean(gaps).toFixed(1)} ms): 추출 ${g('extract')} · 직렬화 ${g('marshal')} · Produce ${g('produce')} · 결과 대기 ${g('wait')} · 블록 생성 ${g('create')} ms`);
}
