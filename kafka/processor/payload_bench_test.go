package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/IBM/sarama"
	"github.com/golang/protobuf/proto"
	"github.com/hyperledger/fabric-protos-go/common"
	"github.com/lovoo/goka"
)

// NOTES §45: 오더러가 envelope 대신 메타데이터만 보내면 Kafka 전송이 얼마나 줄어드는지 잰다.
// incoming 토픽에 남은 실제 배치를 가져와, (1) 그대로(envelope 전체) (2) readTxMeta 로 뽑은 메타데이터
// (3) 작은 메시지(commit 크기) 를 같은 설정(acks=all, 3 복제, 압축)으로 보내고 Produce → 수신 시간을 잰다.
// 배치 1000·2500·5000 은 실제 배치를 이어 붙여 만든다.
//
//	KAFKA_BENCH=host.docker.internal go test -mod=vendor -run TestPayloadLatency -v ./processor/
func TestPayloadLatency(t *testing.T) {
	host := os.Getenv("KAFKA_BENCH")
	if host == "" {
		t.Skip("KAFKA_BENCH=<broker host> 일 때만 돈다")
	}
	brokers := []string{host + ":9091", host + ":9092", host + ":9093"}
	if b := os.Getenv("KAFKA_BENCH_BROKERS"); b != "" { // 도커 내부망으로 직접 (예: kafka1:9090,kafka2:9090,kafka3:9090)
		brokers = strings.Split(b, ",")
	}

	// 1. incoming 에 남은 실제 배치 하나를 가져온다
	batch := fetchRealBatch(t, brokers)
	var envs []*common.Envelope
	for _, b := range batch.Batch {
		env := &common.Envelope{}
		if err := proto.Unmarshal(b, env); err != nil {
			t.Fatal(err)
		}
		envs = append(envs, env)
	}
	t.Logf("실제 배치: %d 건", len(envs))

	type metaMsg struct {
		ID  string   `json:"id"`
		Txs []TxMeta `json:"txs"`
	}
	full := func(k int) []byte { // envelope 전체 (지금 방식). 배치를 k 번 이어 붙인다
		var bs [][]byte
		for i := 0; i < k; i++ {
			bs = append(bs, batch.Batch...)
		}
		out, _ := json.Marshal(TxData{Timestamp: batch.Timestamp, ID: "bench", Batch: bs})
		return out
	}
	meta := func(k int) []byte { // 메타데이터만 (제안)
		var txs []TxMeta
		for i := 0; i < k; i++ {
			for j, env := range envs {
				txs = append(txs, readTxMeta(i*len(envs)+j, env))
			}
		}
		out, _ := json.Marshal(metaMsg{ID: "bench", Txs: txs})
		return out
	}
	// 오더러 쪽에서 메타데이터를 뽑는 비용 (지금은 프로세서가 같은 일을 한다)
	start := time.Now()
	for j, env := range envs {
		readTxMeta(j, env)
	}
	t.Logf("배치 %d 건의 메타데이터 추출: %.2f ms", len(envs), float64(time.Since(start).Microseconds())/1000)

	cfg := goka.DefaultConfig() // 프로세서와 같은 sarama 설정(압축 Snappy). 오더러는 librdkafka + lz4 다
	cfg.Producer.RequiredAcks = sarama.WaitForAll
	cfg.Producer.Return.Successes = true
	cfg.Producer.MaxMessageBytes = 100 * 1024 * 1024
	cfg.Producer.Compression = sarama.CompressionLZ4
	cfg.Producer.Flush.Frequency = time.Millisecond
	cfg.Consumer.Fetch.Max = 100 * 1024 * 1024

	topic := "bench-payload"
	admin, err := sarama.NewClusterAdmin(brokers, cfg)
	if err != nil {
		t.Fatal(err)
	}
	maxBytes := "104857600"
	_ = admin.CreateTopic(topic, &sarama.TopicDetail{NumPartitions: 1, ReplicationFactor: 3,
		ConfigEntries: map[string]*string{"max.message.bytes": &maxBytes}}, false)
	admin.Close()

	prod, err := sarama.NewSyncProducer(brokers, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer prod.Close()
	cons, err := sarama.NewConsumer(brokers, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cons.Close()

	cases := []struct {
		name string
		val  []byte
		n    int
	}{
		{"commit 크기", []byte(strings.Repeat("1,", 150)), 40},
		{"배치 100 envelope", full(1), 40},
		{"배치 100 메타데이터", meta(1), 40},
		{"배치 1000 envelope", full(10), 15},
		{"배치 1000 메타데이터", meta(10), 15},
		{"배치 2500 envelope", full(25), 8},
		{"배치 2500 메타데이터", meta(25), 8},
		{"배치 5000 envelope", full(50), 6},
		{"배치 5000 메타데이터", meta(50), 6},
	}
	t.Logf("| 메시지 | 크기 | 보낸 수 | 전송 확인 p50 / 평균 (ms) | Produce → 수신 p50 / 평균 (ms) |")
	t.Logf("|---|---|---|---|---|")
	for _, c := range cases {
		pc, err := cons.ConsumePartition(topic, 0, sarama.OffsetNewest)
		if err != nil {
			t.Fatal(err)
		}
		var acks, recvs []float64
		for i := 0; i < c.n; i++ {
			sent := time.Now()
			if _, _, err := prod.SendMessage(&sarama.ProducerMessage{Topic: topic, Value: sarama.ByteEncoder(c.val)}); err != nil {
				t.Fatal(err)
			}
			acks = append(acks, ms(time.Since(sent)))
			select {
			case <-pc.Messages():
				recvs = append(recvs, ms(time.Since(sent)))
			case <-time.After(30 * time.Second):
				t.Fatalf("%s: 30초 안에 받지 못했다", c.name)
			}
			time.Sleep(300 * time.Millisecond) // 배치 사이 간격 비슷하게
		}
		pc.Close()
		t.Logf("| %s | %s | %d | %.1f / %.1f | %.1f / %.1f |", c.name, size(len(c.val)), c.n, p50(acks), avg(acks), p50(recvs), avg(recvs))
	}
}

func fetchRealBatch(t *testing.T, brokers []string) TxData {
	cfg := sarama.NewConfig()
	cfg.Consumer.Fetch.Max = 100 * 1024 * 1024
	c, err := sarama.NewConsumer(brokers, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	client, err := sarama.NewClient(brokers, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	parts, _ := client.Partitions("mychannel-incoming")
	for _, p := range parts {
		newest, _ := client.GetOffset("mychannel-incoming", p, sarama.OffsetNewest)
		oldest, _ := client.GetOffset("mychannel-incoming", p, sarama.OffsetOldest)
		for off := newest - 1; off >= oldest && off >= newest-50; off-- {
			pc, err := c.ConsumePartition("mychannel-incoming", p, off)
			if err != nil {
				continue
			}
			select {
			case m := <-pc.Messages():
				pc.Close()
				var d TxData
				if json.Unmarshal(m.Value, &d) == nil && len(d.Batch) >= 90 {
					return d
				}
			case <-time.After(5 * time.Second):
				pc.Close()
			}
		}
	}
	t.Fatal("incoming 토픽에 90건 이상인 배치가 없다")
	return TxData{}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
func avg(x []float64) float64 {
	s := 0.0
	for _, v := range x {
		s += v
	}
	return s / float64(len(x))
}
func p50(x []float64) float64 {
	y := append([]float64(nil), x...)
	sort.Float64s(y)
	return y[len(y)/2]
}
func size(n int) string {
	if n >= 1<<20 {
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%.0f KB", float64(n)/1024)
}
