/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network, artifacts } = require('hardhat');

/**
 * Deploys LoanLedger and writes a machine-readable deployment record.
 *
 * The record is what the backend and the deploy guide read, so the operator
 * never has to copy an address out of scrollback. The owner key stays with the
 * operator; the backend is given a *recorder* key that cannot manage recorders.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network   : ${network.name} (chainId ${chainId})`);
  console.log(`deployer  : ${deployer.address}`);
  console.log(`balance   : ${ethers.formatEther(balance)}`);

  if (network.name !== 'hardhat' && balance === 0n) {
    throw new Error('Deployer has no funds. Fund the account before deploying.');
  }

  const factory = await ethers.getContractFactory('LoanLedger');
  const ledger = await factory.deploy();
  await ledger.waitForDeployment();
  const address = await ledger.getAddress();
  const tx = ledger.deploymentTransaction();

  console.log(`LoanLedger: ${address}`);

  // Optionally authorise the backend recorder wallet at deploy time. The owner
  // key never reaches the API, so this is the only chance to do it from here.
  const recorderAddress = (process.env.CHAIN_RECORDER_ADDRESS || '').trim();
  let recorderAuthorised = null;
  if (recorderAddress) {
    if (!ethers.isAddress(recorderAddress)) {
      throw new Error(`CHAIN_RECORDER_ADDRESS is not a valid address: ${recorderAddress}`);
    }
    const already = await ledger.isRecorder(recorderAddress);
    if (already) {
      recorderAuthorised = recorderAddress;
      console.log(`recorder  : ${recorderAddress} (already authorised)`);
    } else {
      const setTx = await ledger.setRecorder(recorderAddress, true);
      await setTx.wait();
      recorderAuthorised = recorderAddress;
      console.log(`recorder  : ${recorderAddress} (authorised)`);
    }
  } else {
    console.log('recorder  : not set (CHAIN_RECORDER_ADDRESS was empty)');
  }

  const deployment = {
    contract: 'LoanLedger',
    network: network.name,
    chainId,
    address,
    deployer: deployer.address,
    recorder: recorderAuthorised,
    blockNumber: tx ? tx.blockNumber : null,
    txHash: tx ? tx.hash : null,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.resolve(__dirname, '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`written   : ${path.relative(process.cwd(), outFile)}`);

  // Keep the ABI next to the deployment so the backend can talk to the chain
  // without recompiling Solidity.
  const artifact = await artifacts.readArtifact('LoanLedger');
  fs.writeFileSync(
    path.join(outDir, 'LoanLedger.abi.json'),
    `${JSON.stringify(artifact.abi, null, 2)}\n`,
  );

  console.log('\nAdd these to .env to switch on-chain anchoring on:');
  console.log(`LEDGER_CONTRACT_ADDRESS=${address}`);
  console.log(`CHAIN_ID=${chainId}`);
  if (network.name === 'localhost' || network.name === 'hardhat') {
    console.log('CHAIN_RPC_URL=http://127.0.0.1:8545');
  }
  console.log('CHAIN_RECORDER_PRIVATE_KEY=<private key of an authorised recorder>');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
