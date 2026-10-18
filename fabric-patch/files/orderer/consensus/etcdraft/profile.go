package etcdraft

// 오더러 계측 (Serializer NOTES §67). Serializer 오더러가 1,000 TPS 를 다 받지 못하는 원인(§59)을 찾으려고 넣었다.
//
// 초마다 한 줄 [ORDSTAT] (값은 그 1초 동안의 합, ms):
//   recv          run loop 가 받은 tx 수 (submitC 에서 꺼낸 수)
//   submitWait    Submit 이 run loop 에 tx 를 넘기고 리더 답을 받기까지 기다린 시간의 평균·최대.
//                 클라이언트(broadcast) 쪽에서 본 막힘이다.
//   ordered       run loop 가 BlockCutter.Ordered 등 tx 한 건 처리에 쓴 시간
//   propose       run loop 가 propose(메타데이터 추출 → Kafka 전송 → 결과 대기 → 블록 생성)에 쓴 시간
//   idleOpen      run loop 가 tx 를 받을 수 있는데 아무것도 오지 않아 기다린 시간
//   idlePaused    run loop 가 tx 를 받지 않는 상태(블록이 MaxInflightBlocks 만큼 떠 있음 등)로 기다린 시간
//   그 밖: batches, extract/marshal/produce/wait/create (propose 의 구간별 합)
// 배치마다 한 줄 [ORDBATCH]: cut(배치를 propose 에 넘긴 시각, unix ms)과 구간별 시간.
// ORDERER_PROFILE=0 이면 끈다.

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"
)

type ordProf struct {
	on bool

	recv, submitN, submitWaitNs, submitWaitMax int64
	orderedNs, proposeNs, idleOpenNs, idlePausedNs   int64
	batches, extractNs, marshalNs, produceNs, waitNs, createNs int64
}

// propose 한 번(배치 하나)의 구간별 시간
type pushTiming struct {
	extract, marshal, produce time.Duration
}

var prof = newOrdProf()

func newOrdProf() *ordProf {
	p := &ordProf{on: os.Getenv("ORDERER_PROFILE") != "0"}
	if p.on {
		go p.report()
	}
	return p
}

func (p *ordProf) submitted(d time.Duration) {
	if !p.on {
		return
	}
	ns := int64(d)
	atomic.AddInt64(&p.submitN, 1)
	atomic.AddInt64(&p.submitWaitNs, ns)
	for {
		old := atomic.LoadInt64(&p.submitWaitMax)
		if ns <= old || atomic.CompareAndSwapInt64(&p.submitWaitMax, old, ns) {
			break
		}
	}
}

// waited 는 run loop 의 select 가 끝난 직후 부른다. paused 는 select 에 들어갈 때 submitC 가 nil 이었는지다.
func (p *ordProf) waited(start time.Time, paused bool) {
	if !p.on {
		return
	}
	if paused {
		atomic.AddInt64(&p.idlePausedNs, int64(time.Since(start)))
	} else {
		atomic.AddInt64(&p.idleOpenNs, int64(time.Since(start)))
	}
}

func (p *ordProf) add(field *int64, d time.Duration) {
	if p.on {
		atomic.AddInt64(field, int64(d))
	}
}

func (p *ordProf) batch(id string, n int, cut time.Time, t pushTiming, wait, create time.Duration) {
	if !p.on {
		return
	}
	atomic.AddInt64(&p.batches, 1)
	atomic.AddInt64(&p.extractNs, int64(t.extract))
	atomic.AddInt64(&p.marshalNs, int64(t.marshal))
	atomic.AddInt64(&p.produceNs, int64(t.produce))
	atomic.AddInt64(&p.waitNs, int64(wait))
	atomic.AddInt64(&p.createNs, int64(create))
	fmt.Printf("[ORDBATCH] id=%s n=%d cut=%d extract=%.2f marshal=%.2f produce=%.2f wait=%.2f create=%.2f\n",
		id, n, cut.UnixMilli(), ms(t.extract), ms(t.marshal), ms(t.produce), ms(wait), ms(create))
}

func ms(d time.Duration) float64 { return float64(d) / 1e6 }

func (p *ordProf) report() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	take := func(f *int64) int64 { return atomic.SwapInt64(f, 0) }
	nsms := func(f *int64) float64 { return float64(take(f)) / 1e6 }
	for now := range tick.C {
		n := take(&p.submitN)
		sum := take(&p.submitWaitNs)
		avg := 0.0
		if n > 0 {
			avg = float64(sum) / float64(n) / 1e6
		}
		fmt.Printf("[ORDSTAT] t=%d recv=%d submitN=%d submitWaitAvg=%.2f submitWaitMax=%.2f ordered=%.1f propose=%.1f idleOpen=%.1f idlePaused=%.1f batches=%d extract=%.1f marshal=%.1f produce=%.1f wait=%.1f create=%.1f\n",
			now.UnixMilli(), take(&p.recv), n, avg, float64(take(&p.submitWaitMax))/1e6,
			nsms(&p.orderedNs), nsms(&p.proposeNs), nsms(&p.idleOpenNs), nsms(&p.idlePausedNs),
			take(&p.batches), nsms(&p.extractNs), nsms(&p.marshalNs), nsms(&p.produceNs), nsms(&p.waitNs), nsms(&p.createNs))
	}
}
