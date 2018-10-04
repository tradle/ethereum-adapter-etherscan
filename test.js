
const test = require('tape')
const promisify = require('pify')
const { createNetwork } = require('./')
const networkName = 'ropsten'
const luckyTx = {
  txId: '63e30001299d24c89ea7154a7a94d145c552597efa82acc92ff4d16b97bef9c3',
  from: {
    addresses: [
      '7d42e5038444fbfa0b9d9d8c15eff1e27dc5bec6'
    ]
  },
  to: {
    addresses: [
      'f4d8e706cfb25c0decbbdd4d2e2cc10c66376a3f'
    ]
  }
}

test('basic', async (t) => {
  const { blockchain, network } = createNetwork({ networkName })
  t.equal(network.blockchain, 'ethereum')
  t.equal(network.name, 'ropsten')
  t.same(network.constants, { chainId: 3 })

  const key = network.generateKey()
  t.equal(key.pub.length, 64, 'correct key length')

  const pub = new Buffer('000b58d7f8429956219316ded850b365c11f414111ce7ecc28395813ba0a8bc90f3144a4da8754cddb383eddc67b32002aec851f72e02c7421abd5c8dcd3c1c1', 'hex')
  const addr = network.pubKeyToAddress(pub)
  t.equal(addr, '002be406c70dbc7220397ffa6f63a67372cd933c', 'pub key => address')

  const info = await promisify(blockchain.info)()
  t.ok(typeof info.blockHeight === 'number', 'got block height')

  const txs = await promisify(blockchain.transactions.get)(
    ['63e30001299d24c89ea7154a7a94d145c552597efa82acc92ff4d16b97bef9c3']
  )

  t.equal(txs.length, 1, 'retrieved 1 tx')
  compareTxs(txs[0], luckyTx, t)

  const txsForAddr = await promisify(blockchain.addresses.transactions)(
    ['f4d8e706cfb25c0decbbdd4d2e2cc10c66376a3f']
  )

  const match = txsForAddr.find(tx => tx.txId === luckyTx.txId)
  compareTxs(match, luckyTx, t)

  const balance = await promisify(blockchain.addresses.balance)(
    ['f4d8e706cfb25c0decbbdd4d2e2cc10c66376a3f']
  )

  t.equal(typeof balance, 'string', 'balance is stringified num')
  t.notOk(isNaN(balance))
  t.end()
})

function compareTxs (a, b, t) {
  t.equal(a.txId, b.txId)
  t.same(a.from, b.from)
  t.same(a.to, b.to)
}
