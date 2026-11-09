// 支持的链与币种配置
// type: evm  -> Etherscan V2 多链 API（一个 API Key 通用）
//       tron -> TronGrid
//       btc  -> mempool.space

const CHAINS = [
  {
    id: 'ethereum',
    name: 'Ethereum',
    type: 'evm',
    chainId: 1,
    explorer: 'https://etherscan.io/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'ETH', native: true, decimals: 18 },
      { symbol: 'USDT', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'USDC', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
  },
  {
    id: 'bsc',
    name: 'BNB Smart Chain',
    type: 'evm',
    chainId: 56,
    explorer: 'https://bscscan.com/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'BNB', native: true, decimals: 18 },
      { symbol: 'USDT', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDC', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
  },
  {
    id: 'polygon',
    name: 'Polygon',
    type: 'evm',
    chainId: 137,
    explorer: 'https://polygonscan.com/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'POL', native: true, decimals: 18 },
      { symbol: 'USDT', contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      { symbol: 'USDC', contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    ],
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum One',
    type: 'evm',
    chainId: 42161,
    explorer: 'https://arbiscan.io/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'ETH', native: true, decimals: 18 },
      { symbol: 'USDT', contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'USDC', contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
  },
  {
    id: 'base',
    name: 'Base',
    type: 'evm',
    chainId: 8453,
    explorer: 'https://basescan.org/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'ETH', native: true, decimals: 18 },
      { symbol: 'USDC', contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
  },
  {
    id: 'optimism',
    name: 'Optimism',
    type: 'evm',
    chainId: 10,
    explorer: 'https://optimistic.etherscan.io/tx/',
    addressPattern: '^0x[0-9a-fA-F]{40}$',
    tokens: [
      { symbol: 'ETH', native: true, decimals: 18 },
      { symbol: 'USDT', contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      { symbol: 'USDC', contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    ],
  },
  {
    id: 'tron',
    name: 'TRON',
    type: 'tron',
    explorer: 'https://tronscan.org/#/transaction/',
    addressPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$',
    tokens: [
      { symbol: 'TRX', native: true, decimals: 6 },
      { symbol: 'USDT', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
      { symbol: 'USDC', contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6 },
    ],
  },
  {
    id: 'bitcoin',
    name: 'Bitcoin',
    type: 'btc',
    explorer: 'https://mempool.space/tx/',
    addressPattern: '^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$',
    tokens: [{ symbol: 'BTC', native: true, decimals: 8 }],
  },
];

function getChain(id) {
  const chain = CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`不支持的链: ${id}`);
  return chain;
}

module.exports = { CHAINS, getChain };
