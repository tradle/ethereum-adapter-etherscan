
const test = require('tape')
const co = require('co').wrap
const promisify = require('pify')
const createAdapter = require('./')
const networkName = 'ropsten'
const luckyTx = {
  "txId": "341a97b957f7f454dcc8a231a837048e9e798e03c7e1d98e11a657a12b5d98e0",
  "from": {
    "addresses": [
      "7bfb0a289b6f318101a6c3991fb364e2ffd46933"
    ]
  },
  "to": {
    "addresses": [
      "6205908b2caa761128f646fd2743f43fa8d1121b"
    ]
  }
}

test('basic', co(function* (t) {
  const { blockchain } = createAdapter(networkName)
  const info = yield promisify(blockchain.info)()
  t.ok(typeof info.blockHeight === 'number')

  const txs = yield promisify(blockchain.transactions.get)(
    ['341a97b957f7f454dcc8a231a837048e9e798e03c7e1d98e11a657a12b5d98e0']
  )

  t.equal(txs.length, 1)
  compareTxs(txs[0], luckyTx, t)

  const txsForAddr = yield promisify(blockchain.addresses.transactions)(
    ['6205908b2caa761128f646fd2743f43fa8d1121b']
  )

  const match = txsForAddr.find(tx => tx.txId === luckyTx.txId)
  compareTxs(match, luckyTx, t)

  const balance = yield promisify(blockchain.addresses.balance)(
    ['6205908b2caa761128f646fd2743f43fa8d1121b']
  )

  t.equal(typeof balance, 'string')
  t.notOk(isNaN(balance))
  t.end()
}))

function compareTxs (a, b, t) {
  t.equal(a.txId, b.txId)
  t.same(a.from, b.from)
  t.same(a.to, b.to)
}
