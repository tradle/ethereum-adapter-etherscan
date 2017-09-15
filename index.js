
const { EventEmitter } = require('events')
const co = require('co').wrap
const { settle } = require('settle-promise')
const EtherScan = require('etherscan-api')
const Wallet = require('ethereumjs-wallet')
const networks = require('./networks')
const MAX_CONCURRENT_REQUESTS = 3

module.exports = createNetworkAdapter

function noopCallback (cb) {
  if (cb) {
    process.nextTick(cb)
  }
}

function pubKeyToAddress (pub) {
  if (pub.length === 65) pub = pub.slice(1)

  const prefixed = Wallet.fromPublicKey(pub).getAddressString()
  return unprefixHex(prefixed)
}

function generateKey () {
  const key = Wallet.generate(true)
  const exported = {}

  // lazy
  Object.defineProperty(exported, 'pub', {
    get: function () {
      return key.pubKey
    }
  })

  Object.defineProperty(exported, 'priv', {
    get: function () {
      return key.privKey
    }
  })

  return exported
}

function createNetwork (networkName) {
  if (!networks[networkName]) {
    throw new Error(`unsupported network: ${networkName}`)
  }

  return {
    blockchain: 'ethereum',
    name: networkName,
    minOutputAmount: 1,
    constants: networks[networkName],
    pubKeyToAddress,
    generateKey
  }
}

function createNetworkAdapter ({ networkName, apiKey }) {
  const network = createNetwork(networkName)
  const etherscan = EtherScan.init(apiKey, networkName)
  const wrapEtherScanMethod = fn => (...args) => exec(fn(...args))

  let blockHeight
  const _getLatestBlock = wrapEtherScanMethod(etherscan.proxy.eth_blockNumber)
  const getLatestBlock = () => {
    return _getLatestBlock()
      .then(({ result }) => ({
        blockHeight: unhexint(result)
      }))
  }

  const promiseInit = getLatestBlock()
    .then(blockNumber => blockHeight = blockNumber)

  const awaitReady = fn => nodeify(co(function* (...args) {
    yield promiseInit
    return yield fn(...args)
  }))

  const info = getLatestBlock
  const _getBalance = wrapEtherScanMethod(etherscan.account.balance)
  const getBalance = address => {
    return _getBalance(address).then(({ result }) => result[0].balance)
  }

  const _getTx = wrapEtherScanMethod(etherscan.proxy.eth_getTransactionByHash)
  const getTx = hash => {
    return _getTx(prefixHex(hash))
      .then(({ result }) => normalizeTxInfo(result))
  }

  const blockchain = {
    close: noopCallback,
    info: awaitReady(info),
    blocks: {
      latest: awaitReady(getLatestBlock)
    },
    transactions: {
      get: awaitReady(getTxs),
      // propagate: awaitReady(sendTx)
    },
    addresses: {
      transactions: awaitReady(listTxs),
      balance: awaitReady(getBalance)
    }
  }

  function getTxs (hashes) {
    if (!Array.isArray(hashes)) {
      throw new Error('expected array of tx hashes')
    }

    return promiseMapLimit({
      items: hashes,
      worker: getTx,
      concurrency: MAX_CONCURRENT_REQUESTS
    })
  }

  const _listTxsForAddress = wrapEtherScanMethod(etherscan.account.txlist)

  function listTxsForAddress (address) {
    return _listTxsForAddress(prefixHex(address))
      .then(({ result }) => result.map(normalizeTxInfo))
  }

  function listTxs (addresses) {
    if (!Array.isArray(addresses)) {
      throw new Error('expected array of addresses')
    }

    return promiseMapLimit({
      items: addresses,
      worker: listTxsForAddress,
      concurrency: MAX_CONCURRENT_REQUESTS
    })
    .then(flattenArray)
  }

  function normalizeTxInfo (txInfo) {
    const height = Number(txInfo.blockNumber)
    if (!isNaN(txInfo.blockHeight)) {
      blockHeight = Math.max(blockHeight, height)
    }

    return {
      blockHeight,
      txId: unprefixHex(txInfo.hash),
      confirmations: Number(txInfo.confirmations),
      from: {
        addresses: [txInfo.from].map(unprefixHex)
      },
      to: {
        addresses: [txInfo.to].map(unprefixHex)
      }
    }
  }

  return {
    network,
    blockchain
  }
}

function nodeify (promiser) {
  return function (...args) {
    const cb = args.pop()
    return promiser(...args)
      .then(result => cb(null, result), cb)
  }
}

const promiseMapLimit = co(function* ({ items, worker, concurrency=Infinity }) {
  const batches = []
  while (items.length) {
    let batchSize = Math.min(items.length, concurrency)
    batches.push(items.slice(0, batchSize))
    items = items.slice(concurrency)
  }

  let results = []
  for (const batch of batches) {
    const batchResult = yield settle(batch.map(item => worker(item)))
    const successes = batchResult
      .filter(({ isFulfilled }) => isFulfilled)
      .map(({ value }) => value)

    results = results.concat(successes)
  }

  return results
})

function unhexint (hex) {
  return parseInt(unprefixHex(hex), 16)
}

function unprefixHex (hex) {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2)
  }

  return hex
}

function prefixHex (hex) {
  if (!hex.startsWith('0x')) {
    hex = '0x' + hex
  }

  return hex
}

function normalizeResult (result) {
  if (result && result.error) {
    const err = result.error.message
    err.code = result.error.code
    throw err
  }

  return result
}

function normalizeError (err) {
  if (typeof err === 'string') {
    err = new Error(err)
  }

  throw err
}

function exec (req) {
  return req.then(normalizeResult, normalizeError)
}

function flattenArray (arr) {
  return arr.reduce((flat, more) => {
    return flat.concat(more)
  }, [])
}
