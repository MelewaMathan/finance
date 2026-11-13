require('@nomicfoundation/hardhat-toolbox');
const path = require('node:path');
const dotenv = require('dotenv');

// The repo keeps one .env at the root; the contracts workspace reuses it so
// the deployer key and RPC URL are configured in exactly one place.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const AMOY_RPC_URL = process.env.AMOY_RPC_URL || '';
const AMOY_DEPLOYER_PRIVATE_KEY = process.env.AMOY_DEPLOYER_PRIVATE_KEY || '';

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // In-process chain for tests: no funds, no network, deterministic.
    hardhat: { chainId: 31337 },
    // `npm run dev:chain` serves this on 127.0.0.1:8545 for the API.
    localhost: { url: process.env.CHAIN_RPC_URL || 'http://127.0.0.1:8545', chainId: 31337 },
    amoy: {
      url: AMOY_RPC_URL,
      chainId: 80002,
      accounts: AMOY_DEPLOYER_PRIVATE_KEY ? [AMOY_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: { timeout: 60_000 },
};
