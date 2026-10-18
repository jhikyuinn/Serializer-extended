// §59 Serializer 배치 한 주기 분해 (기존 로그만): results/cloud 에서 실행. processor.log [Timing] create(Produce 시각)·recv 와 orderer.log ack·COMMITDATA·Created 를 짝짓는다
const fs=require('fs');const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
for(const b of [100,500,1000])for(const s of ['0','1.0','2.0']){const R=[];
for(const rep of ['rep1','rep2','rep3']){const d=`cloud-s${s}-b${b}/BE/u0/${rep}`;if(!fs.existsSync(d))continue;
 const T=fs.readFileSync(d+'/processor.log','utf8').split('\n').map(l=>l.match(/\[Timing\] n=(\d+) .*create=(\d+) recv=(\d+) decode=([\d.]+) meta=([\d.]+) load=([\d.]+) sched=([\d.]+) save=([\d.]+) encode=([\d.]+)/)).filter(Boolean).map(m=>({n:+m[1],create:+m[2],recv:+m[3],proc:[4,5,6,7,8,9].reduce((a,i)=>a+ +m[i],0)}));
 const O=[];let cur=null;
 for(const l of fs.readFileSync(d+'/orderer.log','utf8').split('\n')){const t=Date.parse(l.split(' ')[0]);
  if(/Delivered message to topic/.test(l)){cur={ack:t};O.push(cur);}else if(cur&&/COMMITDATA/.test(l))cur.cd=t;else if(cur&&/Created block/.test(l))cur.cr=t;else if(cur&&/Writing block/.test(l))cur.wr=t;}
 // 짝: 프로세서 create 와 오더러 ack 가 가장 가까운 것끼리 (ack 는 create 직후)
 for(const t of T){const o=O.find(o=>o.ack>=t.create-5&&o.ack<=t.create+500);if(o&&o.cd&&o.cr)Object.assign(o,t);}
 const P=O.filter(o=>o.create&&o.n>=b*0.9);
 // 정상 구간: 앞 5초 버림
 const t0=P.length?P[0].create+5000:0;const W=P.filter(o=>o.create>=t0);
 for(let i=0;i+1<W.length;i++){const o=W[i],nx=W[i+1];R.push({iv:nx.create-o.create,ack:o.ack-o.create,tr:o.recv-o.create,proc:o.proc,back:o.cd-o.recv-o.proc,blk:o.cr-o.cd,gap:nx.create-o.cr});}}
 const f=k=>mean(R.map(r=>r[k])).toFixed(1);
 console.log(`b${b} s${s} (${R.length}주기): 주기 ${f('iv')} = [Produce→프로세서 수신 ${f('tr')}] + [프로세서 ${f('proc')}] + [commit→오더러 수신 ${f('back')}] + [수신→블록 생성 ${f('blk')}] + [블록 생성→다음 Produce ${f('gap')}]   (참고 Produce→ack ${f('ack')})`);}
