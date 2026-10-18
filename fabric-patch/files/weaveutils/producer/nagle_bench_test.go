package producer

import (
	"os"
	"sort"
	"testing"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// Serializer NOTES §45: 오더러의 Kafka 클라이언트(librdkafka)로 실제 incoming 배치를 보내 전송 확인 시간을 잰다.
// librdkafka 는 기본으로 Nagle 을 켠다(socket.nagle.disable=false). 끄면 달라지는지 본다.
//
//	NAGLE_BENCH=host.docker.internal go test -mod=vendor -run TestNagle -v ./weaveutils/producer/
func TestNagle(t *testing.T) {
	host := os.Getenv("NAGLE_BENCH")
	if host == "" {
		t.Skip("NAGLE_BENCH=<broker host> 일 때만 돈다")
	}
	brokers := host + ":9091," + host + ":9092," + host + ":9093"
	if b := os.Getenv("NAGLE_BROKERS"); b != "" { // 도커 내부망으로 직접 (예: kafka1:9090,kafka2:9090,kafka3:9090)
		brokers = b
	}

	// incoming 의 최근 배치 하나
	c, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": brokers, "group.id": "nagle-bench", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err != nil {
		t.Fatal(err)
	}
	md, err := c.GetMetadata(nil, true, 5000)
	if err != nil {
		t.Fatal(err)
	}
	var payload []byte
	topic := "mychannel-incoming"
	for _, p := range md.Topics[topic].Partitions {
		_, hi, _ := c.QueryWatermarkOffsets(topic, p.ID, 5000)
		if hi == 0 {
			continue
		}
		_ = c.Assign([]kafka.TopicPartition{{Topic: &topic, Partition: p.ID, Offset: kafka.Offset(hi - 2)}})
		if m, err := c.ReadMessage(5 * time.Second); err == nil && len(m.Value) > 300000 {
			payload = m.Value
			break
		}
	}
	c.Close()
	if payload == nil {
		t.Fatal("incoming 에 큰 배치가 없다")
	}
	t.Logf("배치 메시지 %d KB", len(payload)/1024)

	for _, nagleOff := range []bool{false, true, false, true} {
		p, err := kafka.NewProducer(&kafka.ConfigMap{
			"bootstrap.servers":   brokers,
			"acks":                "all",
			"linger.ms":           0,
			"message.max.bytes":   104857600,
			"compression.type":    "lz4",
			"socket.nagle.disable": nagleOff,
		})
		if err != nil {
			t.Fatal(err)
		}
		bt := "bench-payload"
		var acks []float64
		for i := 0; i < 30; i++ {
			dc := make(chan kafka.Event, 1)
			sent := time.Now()
			if err := p.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &bt, Partition: kafka.PartitionAny}, Value: payload}, dc); err != nil {
				t.Fatal(err)
			}
			e := <-dc
			if m, ok := e.(*kafka.Message); ok && m.TopicPartition.Error != nil {
				t.Fatal(m.TopicPartition.Error)
			}
			if i >= 3 { // 연결이 자리잡은 뒤부터
				acks = append(acks, float64(time.Since(sent).Microseconds())/1000)
			}
			time.Sleep(300 * time.Millisecond)
		}
		p.Close()
		sort.Float64s(acks)
		s := 0.0
		for _, a := range acks {
			s += a
		}
		t.Logf("socket.nagle.disable=%v: 전송 확인 p50 %.1f ms, 평균 %.1f ms, p90 %.1f ms", nagleOff, acks[len(acks)/2], s/float64(len(acks)), acks[len(acks)*9/10])
	}
}
