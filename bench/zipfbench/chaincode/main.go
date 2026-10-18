/*
SPDX-License-Identifier: Apache-2.0
*/

// zipf 체인코드: Zipf 분포 키 접근 벤치마크용.
//
//	init(keyCount, initValue)   key_0 ... key_{keyCount-1} 를 initValue로 만든다
//	transfer(keyA, keyB, amount) 두 키를 읽고 두 키를 쓴다 (같은 키를 건드리면 MVCC 충돌)
//	read(key)                    읽기만 한다
//
// 잔액 부족 같은 업무상 실패는 만들지 않는다. 실패는 충돌로만 생기게 한다.
package main

import (
	"fmt"
	"log"
	"os"
	"strconv"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	pb "github.com/hyperledger/fabric-protos-go/peer"
)

type ZipfChaincode struct{}

func (c *ZipfChaincode) Init(stub shim.ChaincodeStubInterface) pb.Response {
	return shim.Success(nil)
}

func (c *ZipfChaincode) Invoke(stub shim.ChaincodeStubInterface) pb.Response {
	fn, args := stub.GetFunctionAndParameters()
	switch fn {
	case "init":
		return initKeys(stub, args)
	case "transfer":
		return transfer(stub, args)
	case "read":
		return read(stub, args)
	}
	return shim.Error(fmt.Sprintf("unknown function %q", fn))
}

func key(i int) string { return fmt.Sprintf("key_%d", i) }

func initKeys(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		return shim.Error("init(keyCount, initValue)")
	}
	n, err := strconv.Atoi(args[0])
	if err != nil || n <= 0 {
		return shim.Error("keyCount must be a positive integer")
	}
	if _, err := strconv.ParseInt(args[1], 10, 64); err != nil {
		return shim.Error("initValue must be an integer")
	}
	for i := 0; i < n; i++ {
		if err := stub.PutState(key(i), []byte(args[1])); err != nil {
			return shim.Error(err.Error())
		}
	}
	return shim.Success([]byte(strconv.Itoa(n)))
}

func balance(stub shim.ChaincodeStubInterface, k string) (int64, error) {
	v, err := stub.GetState(k)
	if err != nil {
		return 0, err
	}
	if v == nil {
		return 0, fmt.Errorf("%s does not exist", k)
	}
	return strconv.ParseInt(string(v), 10, 64)
}

func transfer(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		return shim.Error("transfer(keyA, keyB, amount)")
	}
	amount, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil {
		return shim.Error("amount must be an integer")
	}
	a, err := balance(stub, args[0])
	if err != nil {
		return shim.Error(err.Error())
	}
	b, err := balance(stub, args[1])
	if err != nil {
		return shim.Error(err.Error())
	}
	if err := stub.PutState(args[0], []byte(strconv.FormatInt(a-amount, 10))); err != nil {
		return shim.Error(err.Error())
	}
	if err := stub.PutState(args[1], []byte(strconv.FormatInt(b+amount, 10))); err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success(nil)
}

func read(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 1 {
		return shim.Error("read(key)")
	}
	v, err := stub.GetState(args[0])
	if err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success(v)
}

func main() {
	// 서비스형(ccaas): 체인코드가 서버가 되고 피어가 접속해 온다
	if addr := os.Getenv("CHAINCODE_SERVER_ADDRESS"); addr != "" {
		server := &shim.ChaincodeServer{
			CCID:     os.Getenv("CHAINCODE_ID"),
			Address:  addr,
			CC:       &ZipfChaincode{},
			TLSProps: shim.TLSProperties{Disabled: true},
		}
		if err := server.Start(); err != nil {
			log.Panicf("chaincode server: %v", err)
		}
		return
	}
	if err := shim.Start(&ZipfChaincode{}); err != nil {
		log.Panicf("chaincode: %v", err)
	}
}
