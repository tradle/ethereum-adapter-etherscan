
const { settle } = require('settle-promise')
const EtherScan = require('etherscan-api')
const Wallet = require('ethereumjs-wallet')
const networks = require('./networks')
const MAX_CONCURRENT_REQUESTS = 3

const noopCallback = (cb) => {
  if (cb) process.nextTick(cb)
}

const pubKeyToAddress = (pub) => {
  if (pub.length === 65) pub = pub.slice(1)

  const prefixed = Wallet.fromPublicKey(pub).getAddressString()
  return unprefixHex(prefixed)
}

const generateKey = () => {
  const key = Wallet.generate(true)
  const exported = {}

  // lazy
  Object.defineProperty(exported, 'pub', {
    get: () => key.pubKey
  })

  Object.defineProperty(exported, 'priv', {
    get: () => key.privKey
  })

  return exported
}

const createNetwork = ({ networkName, apiKey }) => {
  if (!networks[networkName]) {
    throw new Error(`unsupported network: ${networkName}`)
  }

  let api
  const network = {
    blockchain: 'ethereum',
    name: networkName,
    curve: 'secp256k1',
    minOutputAmount: 1,
    constants: networks[networkName],
    pubKeyToAddress,
    generateKey,
    createBlockchainAPI,
    get api () {
      if (!api) {
        api = createBlockchainAPI({ network, apiKey })
      }

      return api
    }
  }

  return network
}

const mem = fn => {
  let promise
  const memoized = () => {
    if (!promise) {
      promise = fn()
      promise.catch(() => {
        promise = null
      })
    }

    return promise
  }

  return memoized
}

const createBlockchainAPI = ({ network, networkName, apiKey }) => {
  if (!network) network = createNetwork(networkName)

  networkName = network.name
  const etherscan = EtherScan.init(apiKey, networkName)
  const wrapEtherScanMethod = fn => (...args) => exec(fn(...args))

  let blockHeight
  const _getLatestBlock = wrapEtherScanMethod(etherscan.proxy.eth_blockNumber)
  const getLatestBlock = () => _getLatestBlock().then(({ result }) => ({
    blockHeight: unhexint(result)
  }))

  const _init = async () => {
    if (blockHeight) return
    const result = await getLatestBlock()
    if (!blockHeight) blockHeight = result.blockHeight
  }

  const init = mem(_init)

  // kick things off
  init()

  const requireReady = fn => nodeify(async (...args) => {
    await init()
    return await fn(...args)
  })

  const info = getLatestBlock
  const _getBalance = wrapEtherScanMethod(etherscan.account.balance)
  const getBalance = async address => {
    const { result } = await _getBalance(address)
    return result[0].balance
  }

  const _getTx = wrapEtherScanMethod(etherscan.proxy.eth_getTransactionByHash)
  const getTx = async hash => {
    const { result } = await _getTx(prefixHex(hash))
    return normalizeTxInfo(result)
  }

  const getTxs = (hashes) => {
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

  const listTxsForAddress = (address) => {
    return _listTxsForAddress(prefixHex(address))
      .then(({ result }) => result.map(normalizeTxInfo))
  }

  const listTxs = (addresses) => {
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

  const normalizeTxInfo = (txInfo) => {
    const height = toNumber(txInfo.blockNumber)
    let confirmations
    if (isNaN(height)) {
      // eslint-disable-next-line no-console
      console.warn('height is not a number!', txInfo)
    } else {
      blockHeight = Math.max(blockHeight, height)
      confirmations = blockHeight - height
    }

    return {
      blockHeight,
      txId: unprefixHex(txInfo.hash),
      confirmations,
      from: {
        addresses: [txInfo.from].map(unprefixHex)
      },
      to: {
        addresses: [txInfo.to].map(unprefixHex)
      },
      data: unprefixHex(txInfo.input || '')
    }
  }

  const blockchain = {
    network,
    close: noopCallback,
    info: requireReady(info),
    blocks: {
      latest: requireReady(getLatestBlock)
    },
    transactions: {
      get: requireReady(getTxs),
      // propagate: requireReady(sendTx)
    },
    addresses: {
      transactions: requireReady(listTxs),
      balance: requireReady(getBalance)
    }
  }

  return blockchain
}

const nodeify = promiser => function (...args) {
  const cb = args.pop()
  return promiser(...args)
    .then(result => cb(null, result), cb)
}

const promiseMapLimit = async ({ items, worker, concurrency=Infinity }) => {
  const batches = []
  while (items.length) {
    let batchSize = Math.min(items.length, concurrency)
    batches.push(items.slice(0, batchSize))
    items = items.slice(concurrency)
  }

  let results = []
  for (const batch of batches) {
    const batchResult = await settle(batch.map(item => worker(item)))
    const successes = batchResult
      .filter(({ isFulfilled }) => isFulfilled)
      .map(({ value }) => value)

    results = results.concat(successes)
  }

  return results
}

const unhexint = hex => parseInt(unprefixHex(hex), 16)
const unprefixHex = hex => hex.startsWith('0x') ? hex.slice(2) : hex
const prefixHex = hex => hex.startsWith('0x') ? hex : '0x' + hex
const normalizeResult = (result) => {
  if (result && result.error) {
    const err = result.error.message
    err.code = result.error.code
    throw err
  }

  return result
}

const normalizeError = (err) => {
  if (typeof err === 'string') {
    err = new Error(err)
  }

  throw err
}

const exec = req => req.then(normalizeResult, normalizeError)
const flattenArray = arr => arr.reduce((flat, more) => {
  return flat.concat(more)
}, [])

const toNumber = (n) => {
  if (typeof n === 'number') return n
  if (n.startsWith('0x')) return unhexint(n)

  return isNaN(n) ? null : parseInt(n, 10)
}

module.exports = {
  networks,
  createNetwork,
  createBlockchainAPI
}
