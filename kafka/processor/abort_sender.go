package main

import (
	"fmt"
	"time"

	"github.com/IBM/sarama"
	"github.com/lovoo/goka"
)

// abort 기록을 어떻게 보낼지 (NOTES §37·§38 실험용, -abort-mode / -abort-delay).
//
//	inline   commit 바로 뒤에 같은 goka producer 로 보낸다 (예전 방식. commit 이 약 40 ms 늦어진다, §38)
//	separate 따로 만든 producer(다른 연결)로 commit 바로 뒤에 보낸다 (기본)
//	delayed  따로 만든 producer 로 -abort-delay 뒤에 보낸다
//
// §37 에서 abort 를 버리는 시스템만 commit 이 오더러에 닿기까지 약 40 ms 더 걸렸다. commit 바로 뒤에
// 같은 producer 로 나가는 큰 abort 기록(버린 tx 의 envelope 전체)이 commit 을 늦추는지 확인한다.
var (
	abortMode     = "separate"
	abortDelay    time.Duration
	abortProducer sarama.AsyncProducer
)

func startAbortProducer(brokers []string) error {
	if abortMode == "inline" {
		return nil
	}
	if abortMode != "separate" && abortMode != "delayed" {
		return fmt.Errorf("unknown -abort-mode %q (inline | separate | delayed)", abortMode)
	}
	cfg := goka.DefaultConfig() // 압축(Snappy)·분할·Flush 설정을 goka producer 와 같게 둔다
	cfg.Producer.Flush.Frequency = time.Millisecond
	cfg.Producer.MaxMessageBytes = 100 * 1024 * 1024
	p, err := sarama.NewAsyncProducer(brokers, cfg)
	if err != nil {
		return err
	}
	go func() {
		for range p.Successes() {
		}
	}()
	go func() {
		for e := range p.Errors() {
			fmt.Printf("abort producer error: %v\n", e.Err)
		}
	}()
	abortProducer = p
	fmt.Printf("abort mode: %s delay=%s\n", abortMode, abortDelay)
	return nil
}

// emitAbort sends one abort record according to abortMode.
func emitAbort(ctx goka.Context, key string, value []byte) {
	if abortProducer == nil {
		ctx.Emit(TopicAbort, key, value)
		return
	}
	msg := &sarama.ProducerMessage{Topic: string(TopicAbort), Key: sarama.StringEncoder(key), Value: sarama.ByteEncoder(value)}
	if abortMode == "delayed" && abortDelay > 0 {
		time.AfterFunc(abortDelay, func() { abortProducer.Input() <- msg })
		return
	}
	abortProducer.Input() <- msg
}
