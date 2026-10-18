'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

// Zipf 분포로 고른 두 키 사이의 transfer(keyA, keyB, amount) 를 보낸다.
//
// roundArguments
//   keyCount  키 개수 N (체인코드 init 과 같아야 한다)        기본 1000
//   zipfS     Zipf 지수 s (0 이면 균등)                         기본 0
//   amount    한 번에 옮기는 양                                 기본 1
//   seed      난수 씨앗. 워커마다 seed + workerIndex 를 쓴다    기본 12345
//
// 순위 k(1..N)의 확률은 1/k^s 에 비례한다. 순위 k 는 키 key_{k-1} 이다. 누적분포(CDF)를
// 한 번 만들어 두고 균등 난수를 이분 탐색으로 순위로 바꾼다. keyA, keyB 를 따로 뽑고
// 같으면 keyB 를 다시 뽑는다.

// mulberry32: 씨앗이 같으면 같은 수열을 내는 32비트 난수기
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildCdf(n, s) {
    const cdf = new Float64Array(n);
    let total = 0;
    for (let k = 1; k <= n; k++) {
        total += 1 / Math.pow(k, s);
        cdf[k - 1] = total;
    }
    for (let i = 0; i < n; i++) {
        cdf[i] /= total;
    }
    cdf[n - 1] = 1;
    return cdf;
}

// u 이상인 첫 칸을 찾는다. 돌려주는 값은 0부터 시작하는 순위(= 키 번호)다.
function sample(cdf, u) {
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cdf[mid] < u) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

class ZipfTransferWorkload extends WorkloadModuleBase {
    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        this.keyCount = Number(roundArguments.keyCount || 1000);
        this.zipfS = Number(roundArguments.zipfS || 0);
        this.amount = String(roundArguments.amount || 1);
        this.contractId = roundArguments.contractId || 'zipf';
        this.cdf = buildCdf(this.keyCount, this.zipfS);
        this.rand = mulberry32(Number(roundArguments.seed || 12345) + workerIndex);
    }

    nextPair() {
        const a = sample(this.cdf, this.rand());
        let b = sample(this.cdf, this.rand());
        while (b === a) {
            b = sample(this.cdf, this.rand());
        }
        return [`key_${a}`, `key_${b}`];
    }

    async submitTransaction() {
        const [keyA, keyB] = this.nextPair();
        return this.sutAdapter.sendRequests({
            contractId: this.contractId,
            contractFunction: 'transfer',
            contractArguments: [keyA, keyB, this.amount],
            invokerIdentity: 'User1',
            readOnly: false
        });
    }
}

function createWorkloadModule() {
    return new ZipfTransferWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
module.exports.buildCdf = buildCdf;
module.exports.sample = sample;
module.exports.mulberry32 = mulberry32;
