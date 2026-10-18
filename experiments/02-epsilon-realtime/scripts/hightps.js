// §69 고부하 간이 확인 요약: results/ht-t<TPS>-b<B>/BE/u0/rep1 (+ /opt/work/cpu-ht-*.txt 를 같은 폴더로 가져온 것)
//   node hightps.js <results 폴더>
const fs = require('fs'), path = require('path');
const R = process.argv[2] || '.', P = process.argv[3] || 'ht';
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const num = (s, k) => { const m = s.match(new RegExp(`\\b${k}=([\\d.]+)`)); return m ? +m[1] : NaN; };
function promDelta(dir) { // 피어 블록 처리 시간(ms/블록): org1 피어
  try {
    const get = (f) => {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f))).data.result.filter((x) => x.metric.instance && x.metric.instance.startsWith('peer0.org1'));
      const v = (n) => +((r.find((x) => x.metric.__name__ === n) || {}).value || [0, 0])[1];
      return [v('ledger_block_processing_time_sum'), v('ledger_block_processing_time_count')];
    };
    const a = get('prom-before.json'), b = get('prom-after.json');
    return { ms: 1000 * (b[0] - a[0]) / (b[1] - a[1]), blocks: b[1] - a[1] };
  } catch (e) { return { ms: NaN, blocks: NaN }; }
}
console.log('| 배치 | 목표 TPS | 보낸 TPS | 오더러 받은/s | 성공/s | 성공률 | 커밋 지연 | 시간 초과 | 블록 간격 | 블록당 tx | 피어 블록 처리 | 클라이언트 CPU |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const b of [100, 1000]) for (const t of [2000, 3000, 4000, 5000]) {
  const run = path.join(R, `${P}-t${t}-b${b}`), dir = path.join(run, 'BE/u0/rep1');
  if (!fs.existsSync(dir)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
  const a = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('user-')))
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f))).tallySteady.all)) a[k] = (a[k] || 0) + v;
  const ol = fs.readFileSync(path.join(dir, 'orderer.log'), 'utf8').split('\n');
  const st = ol.filter((l) => l.includes('[ORDSTAT]')).map((l) => ({ recv: num(l, 'recv') }));
  const i0 = st.findIndex((r) => r.recv > 0), i1 = st.length - 1 - [...st].reverse().findIndex((r) => r.recv > 0);
  const recv = mean(st.slice(i0 + 5, i1).map((r) => r.recv));
  const bt = ol.filter((l) => l.includes('[ORDBATCH]')).map((l) => ({ n: num(l, 'n'), cut: num(l, 'cut') }));
  const gaps = []; for (let i = 1; i < bt.length; i++) gaps.push(bt[i].cut - bt[i - 1].cut);
  const gap = mean(gaps.slice(Math.floor(gaps.length * 0.2), Math.floor(gaps.length * 0.8)));
  const pc = promDelta(dir);
  let cpu = NaN;
  const cf = path.join(run, `cpu-${P}-t${t}-b${b}.txt`);
  if (fs.existsSync(cf)) {
    const idle = fs.readFileSync(cf, 'utf8').split('\n').map((l) => l.match(/([\d.]+)\s*id/)).filter(Boolean).map((m) => 100 - +m[1]);
    const busy = idle.filter((x) => x > 10); cpu = mean(busy.slice(2, -2));
  }
  console.log(`| ${b} | ${t} | ${(a.total / dur).toFixed(0)} | ${recv.toFixed(0)} | ${(a.success / dur).toFixed(0)} | ${(100 * a.success / a.total).toFixed(1)}% | ${(a.latencySuccessSum / a.success).toFixed(0)} ms | ${a.failSlow} | ${gap.toFixed(0)} ms | ${mean(bt.map((x) => x.n)).toFixed(0)} | ${pc.ms.toFixed(0)} ms | ${cpu.toFixed(0)}% |`);
}
