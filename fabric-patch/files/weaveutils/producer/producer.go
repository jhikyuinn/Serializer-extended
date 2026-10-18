package producer

import (
	"os"
	"strconv"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// var (
// 	kafkabroker1 = "kafka-host:9091"
// 	kafkabroker2 = "kafka-host:9092"
// 	kafkabroker3 = "kafka-host:9093"
// )

// 로컬 실행: Kafka는 이 PC에서 돌고, 컨테이너와 호스트 양쪽에서 host.docker.internal로 닿는다
var (
	kafkabroker1 = "host.docker.internal:9091"
	kafkabroker2 = "host.docker.internal:9092"
	kafkabroker3 = "host.docker.internal:9093"
)

func Config() *kafka.Producer {
	// KAFKA_BROKERS 가 있으면 그 목록을 쓴다 (예: 도커 내부망 kafka1:9090,kafka2:9090,kafka3:9090,
	// 다른 호스트면 그 주소). 없으면 예전처럼 host.docker.internal 포트 전달(Serializer NOTES §45: 느리다).
	brokers := kafkabroker1 + "," + kafkabroker2 + "," + kafkabroker3
	if b := os.Getenv("KAFKA_BROKERS"); b != "" {
		brokers = b
	}

	linger, _ := strconv.Atoi(os.Getenv("KAFKA_LINGER"))

	// 배치(수백 KB~수 MB)를 압축해 보낸다. 서명·인증서가 반복되어 잘 줄어든다. 프로세서(sarama)가 푼다.
	compression := os.Getenv("KAFKA_COMPRESSION")
	if compression == "" {
		compression = "lz4"
	}

	p, _ := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": brokers,
		"acks":              "all",
		"linger.ms":         linger,
		"message.max.bytes": 104857600,
		"compression.type":  compression,
	})

	return p
}
