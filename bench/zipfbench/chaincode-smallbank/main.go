/*
SPDX-License-Identifier: Apache-2.0
*/

// smallbank 체인코드: Serializer 논문(IEEE Access) Figure 7의 방식으로 사용자와 긴급 여부를
// 트랜잭션의 읽기 집합에 남긴다.
//
// 모든 호출의 앞 세 인자는 호출한 사용자, 긴급 여부, 요청 ID 다.
//
//	<함수>(invoker, urgent, reqId, ...)   urgent 는 "1" 이면 긴급
//
// reqId 는 체인코드가 쓰지 않는다. 클라이언트가 abort 토픽(프로세서가 abort 된 트랜잭션의 호출 인자를
// 함께 보낸다)에서 자기 요청을 찾는 데 쓴다.
//
// 체인코드는 먼저 사용자 정보 키 info_<invoker> ({"Id":..,"Priority":..})를 읽는다. 긴급이면
// 사용자가 VIP 인지 확인하고(아니면 거절) 긴급 표시 키 flag_urgent 를 읽는다. 두 키는 init 말고는
// 아무도 쓰지 않으므로 충돌을 만들지 않는다(논문: "이 정보는 충돌을 피하려고 쓰기 집합에 넣지 않는다").
// 프로세서는 읽기 집합의 이 두 키로 사용자와 긴급 여부를 안다.
//
// 계좌는 계좌마다 당좌(checking_<i>)와 저축(savings_<i>) 두 키다. 트랜잭션은 smallbank 6종이다.
//
//	TransactSavings(a, amount)  savings_a 를 읽고 쓴다
//	DepositChecking(a, amount)  checking_a 를 읽고 쓴다
//	SendPayment(a, b, amount)   checking_a, checking_b 를 읽고 쓴다
//	WriteCheck(a, amount)       savings_a, checking_a 를 읽고 checking_a 를 쓴다
//	Amalgamate(a, b)            savings_a, checking_a, checking_b 를 읽고 셋 다 쓴다 (a 의 전액을 b 당좌로)
//	Query(a)                    savings_a, checking_a 를 읽기만 한다
//
// 보조 부하 (Fabric++ 논문 6.2.2절의 custom 워크로드):
//
//	Custom(nReads, r1..rn, w1..wm)  키 r1..rn 을 읽고 w1..wm 에 쓴다 (item_<i> 키, init 불필요)
//
// 읽는 키와 쓰는 키를 따로 고르므로, smallbank 와 달리 "읽은 쪽을 먼저 두면 둘 다 성공하는" 충돌이 많다.
// 쓰는 값은 트랜잭션 ID 다(보증 피어끼리 같아야 한다).
//
// init(accountCount, initBalance, users, vips) 는 계좌와 사용자 정보를 만든다.
// users, vips 는 쉼표로 구분한 사용자 이름이다 (예: "User1,User2,User3,User4,User5", "User3").
//
// 잔액 부족 같은 업무상 실패는 만들지 않는다(잔액이 음수가 될 수 있다). 실패는 충돌로만 생긴다.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	pb "github.com/hyperledger/fabric-protos-go/peer"
)

const (
	infoPrefix = "info_"
	urgentKey  = "flag_urgent"
)

type UserInfo struct {
	Id       string `json:"Id"`
	Priority string `json:"Priority"`
}

type SmallbankChaincode struct{}

func (c *SmallbankChaincode) Init(stub shim.ChaincodeStubInterface) pb.Response {
	return shim.Success(nil)
}

func (c *SmallbankChaincode) Invoke(stub shim.ChaincodeStubInterface) pb.Response {
	fn, args := stub.GetFunctionAndParameters()
	if fn == "init" {
		return initLedger(stub, args)
	}
	if len(args) < 3 {
		return shim.Error(fmt.Sprintf("%s(invoker, urgent, reqId, ...)", fn))
	}
	if err := markInvoker(stub, args[0], args[1] == "1"); err != nil {
		return shim.Error(err.Error())
	}
	args = args[3:]

	var err error
	switch fn {
	case "TransactSavings":
		err = addTo(stub, args, "savings_")
	case "DepositChecking":
		err = addTo(stub, args, "checking_")
	case "SendPayment":
		err = sendPayment(stub, args)
	case "WriteCheck":
		err = writeCheck(stub, args)
	case "Amalgamate":
		err = amalgamate(stub, args)
	case "Query":
		return query(stub, args)
	case "Custom":
		err = custom(stub, args)
	default:
		err = fmt.Errorf("unknown function %q", fn)
	}
	if err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success(nil)
}

// markInvoker puts the invoker (and, if urgent, the urgent flag) into the read set.
func markInvoker(stub shim.ChaincodeStubInterface, invoker string, urgent bool) error {
	raw, err := stub.GetState(infoPrefix + invoker)
	if err != nil {
		return err
	}
	if raw == nil {
		return fmt.Errorf("unknown user %s", invoker)
	}
	if !urgent {
		return nil
	}
	var info UserInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return err
	}
	if info.Priority != "VIP" {
		return fmt.Errorf("user %s (%s) may not send urgent transactions", invoker, info.Priority)
	}
	_, err = stub.GetState(urgentKey)
	return err
}

func checking(a string) string { return "checking_" + a }
func savings(a string) string  { return "savings_" + a }

func balance(stub shim.ChaincodeStubInterface, key string) (int64, error) {
	v, err := stub.GetState(key)
	if err != nil {
		return 0, err
	}
	if v == nil {
		return 0, fmt.Errorf("%s does not exist", key)
	}
	return strconv.ParseInt(string(v), 10, 64)
}

func put(stub shim.ChaincodeStubInterface, key string, v int64) error {
	return stub.PutState(key, []byte(strconv.FormatInt(v, 10)))
}

func amountArg(s string) (int64, error) {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("amount must be an integer")
	}
	return v, nil
}

// addTo: TransactSavings / DepositChecking (a, amount)
func addTo(stub shim.ChaincodeStubInterface, args []string, prefix string) error {
	if len(args) != 2 {
		return fmt.Errorf("(account, amount)")
	}
	amount, err := amountArg(args[1])
	if err != nil {
		return err
	}
	key := prefix + args[0]
	b, err := balance(stub, key)
	if err != nil {
		return err
	}
	return put(stub, key, b+amount)
}

func sendPayment(stub shim.ChaincodeStubInterface, args []string) error {
	if len(args) != 3 {
		return fmt.Errorf("SendPayment(from, to, amount)")
	}
	amount, err := amountArg(args[2])
	if err != nil {
		return err
	}
	from, err := balance(stub, checking(args[0]))
	if err != nil {
		return err
	}
	to, err := balance(stub, checking(args[1]))
	if err != nil {
		return err
	}
	if err := put(stub, checking(args[0]), from-amount); err != nil {
		return err
	}
	return put(stub, checking(args[1]), to+amount)
}

func writeCheck(stub shim.ChaincodeStubInterface, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("WriteCheck(account, amount)")
	}
	amount, err := amountArg(args[1])
	if err != nil {
		return err
	}
	sav, err := balance(stub, savings(args[0]))
	if err != nil {
		return err
	}
	chk, err := balance(stub, checking(args[0]))
	if err != nil {
		return err
	}
	if sav+chk < amount { // smallbank: 잔액이 모자라면 1 을 더 뺀다 (실패시키지 않는다)
		amount++
	}
	return put(stub, checking(args[0]), chk-amount)
}

func amalgamate(stub shim.ChaincodeStubInterface, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("Amalgamate(from, to)")
	}
	sav, err := balance(stub, savings(args[0]))
	if err != nil {
		return err
	}
	chk, err := balance(stub, checking(args[0]))
	if err != nil {
		return err
	}
	to, err := balance(stub, checking(args[1]))
	if err != nil {
		return err
	}
	if err := put(stub, savings(args[0]), 0); err != nil {
		return err
	}
	if err := put(stub, checking(args[0]), 0); err != nil {
		return err
	}
	return put(stub, checking(args[1]), to+sav+chk)
}

// custom: (nReads, reads..., writes...)
func custom(stub shim.ChaincodeStubInterface, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("Custom(nReads, reads..., writes...)")
	}
	n, err := strconv.Atoi(args[0])
	if err != nil || n < 0 || n > len(args)-1 {
		return fmt.Errorf("nReads must be 0..%d", len(args)-1)
	}
	for _, k := range args[1 : 1+n] {
		if _, err := stub.GetState(k); err != nil {
			return err
		}
	}
	v := []byte(stub.GetTxID())
	for _, k := range args[1+n:] {
		if err := stub.PutState(k, v); err != nil {
			return err
		}
	}
	return nil
}

func query(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 1 {
		return shim.Error("Query(account)")
	}
	sav, err := balance(stub, savings(args[0]))
	if err != nil {
		return shim.Error(err.Error())
	}
	chk, err := balance(stub, checking(args[0]))
	if err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success([]byte(strconv.FormatInt(sav+chk, 10)))
}

func initLedger(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 4 {
		return shim.Error("init(accountCount, initBalance, users, vips)")
	}
	n, err := strconv.Atoi(args[0])
	if err != nil || n <= 0 {
		return shim.Error("accountCount must be a positive integer")
	}
	initBalance, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil {
		return shim.Error("initBalance must be an integer")
	}
	vip := map[string]bool{}
	for _, u := range strings.Split(args[3], ",") {
		if u = strings.TrimSpace(u); u != "" {
			vip[u] = true
		}
	}
	for i := 0; i < n; i++ {
		a := strconv.Itoa(i)
		if err := put(stub, checking(a), initBalance); err != nil {
			return shim.Error(err.Error())
		}
		if err := put(stub, savings(a), initBalance); err != nil {
			return shim.Error(err.Error())
		}
	}
	users := 0
	for _, u := range strings.Split(args[2], ",") {
		if u = strings.TrimSpace(u); u == "" {
			continue
		}
		priority := "SILVER"
		if vip[u] {
			priority = "VIP"
		}
		raw, _ := json.Marshal(UserInfo{Id: u, Priority: priority})
		if err := stub.PutState(infoPrefix+u, raw); err != nil {
			return shim.Error(err.Error())
		}
		users++
	}
	if err := stub.PutState(urgentKey, []byte("1")); err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success([]byte(fmt.Sprintf("%d accounts, %d users", n, users)))
}

func main() {
	// 서비스형(ccaas): 체인코드가 서버가 되고 피어가 접속해 온다
	if addr := os.Getenv("CHAINCODE_SERVER_ADDRESS"); addr != "" {
		server := &shim.ChaincodeServer{
			CCID:     os.Getenv("CHAINCODE_ID"),
			Address:  addr,
			CC:       &SmallbankChaincode{},
			TLSProps: shim.TLSProperties{Disabled: true},
		}
		if err := server.Start(); err != nil {
			log.Panicf("chaincode server: %v", err)
		}
		return
	}
	if err := shim.Start(&SmallbankChaincode{}); err != nil {
		log.Panicf("chaincode: %v", err)
	}
}
