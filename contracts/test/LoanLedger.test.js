const { expect } = require('chai');
const { ethers } = require('hardhat');

/**
 * LoanLedger behaviour.
 *
 * The tests are written from the attacker's point of view: replay a proof,
 * write as an unauthorised wallet, try to rewind the audit anchor. Those are
 * precisely the properties the API relies on.
 */
describe('LoanLedger', () => {
  const loanRef = ethers.keccak256(ethers.toUtf8Bytes('SMF-2026-000001'));
  const recordHash = ethers.keccak256(ethers.toUtf8Bytes('SMF1|txn-1|repayment|175000'));
  let ledger;
  let owner;
  let recorder;
  let stranger;

  const now = async () => {
    const block = await ethers.provider.getBlock('latest');
    return block.timestamp;
  };

  beforeEach(async () => {
    [owner, recorder, stranger] = await ethers.getSigners();
    ledger = await ethers.deployContract('LoanLedger');
    await ledger.waitForDeployment();
  });

  describe('appending proofs', () => {
    it('stores a record and makes it verifiable', async () => {
      const occurredAt = await now();
      await expect(ledger.record(loanRef, 1, occurredAt, recordHash))
        .to.emit(ledger, 'Recorded')
        .withArgs(recordHash, loanRef, 1, occurredAt, owner.address);

      const [exists, storedRef, txType, storedAt, storedBy] = await ledger.verify(recordHash);
      expect(exists).to.equal(true);
      expect(storedRef).to.equal(loanRef);
      expect(txType).to.equal(1);
      expect(storedAt).to.equal(occurredAt);
      expect(storedBy).to.equal(owner.address);
      expect(await ledger.exists(recordHash)).to.equal(true);
      expect(await ledger.recordCount()).to.equal(1);
    });

    it('refuses to record the same proof hash twice', async () => {
      const occurredAt = await now();
      await ledger.record(loanRef, 0, occurredAt, recordHash);
      await expect(ledger.record(loanRef, 0, occurredAt, recordHash)).to.be.revertedWithCustomError(
        ledger,
        'AlreadyRecorded',
      );
      expect(await ledger.recordCount()).to.equal(1);
    });

    it('rejects zero hashes, invalid types and future timestamps', async () => {
      const occurredAt = await now();
      await expect(ledger.record(loanRef, 0, occurredAt, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ledger,
        'ZeroHash',
      );
      await expect(
        ledger.record(ethers.ZeroHash, 0, occurredAt, recordHash),
      ).to.be.revertedWithCustomError(ledger, 'ZeroLoanRef');
      await expect(ledger.record(loanRef, 2, occurredAt, recordHash)).to.be.revertedWithCustomError(
        ledger,
        'InvalidTxType',
      );
      await expect(
        ledger.record(loanRef, 0, occurredAt + 86_400, recordHash),
      ).to.be.revertedWithCustomError(ledger, 'FutureTimestamp');
    });

    it('only lets authorised recorders append', async () => {
      const occurredAt = await now();
      await expect(
        ledger.connect(stranger).record(loanRef, 0, occurredAt, recordHash),
      ).to.be.revertedWithCustomError(ledger, 'NotRecorder');

      await ledger.setRecorder(recorder.address, true);
      expect(await ledger.isRecorder(recorder.address)).to.equal(true);

      await expect(ledger.connect(recorder).record(loanRef, 0, occurredAt, recordHash))
        .to.emit(ledger, 'Recorded')
        .withArgs(recordHash, loanRef, 0, occurredAt, recorder.address);

      // Revocation takes effect immediately.
      await ledger.setRecorder(recorder.address, false);
      const otherHash = ethers.keccak256(ethers.toUtf8Bytes('another proof'));
      await expect(
        ledger.connect(recorder).record(loanRef, 0, occurredAt, otherHash),
      ).to.be.revertedWithCustomError(ledger, 'NotRecorder');
    });

    it('only the owner can manage recorders', async () => {
      await expect(
        ledger.connect(stranger).setRecorder(stranger.address, true),
      ).to.be.revertedWithCustomError(ledger, 'NotOwner');
    });

    it('reports a missing proof without reverting', async () => {
      const [exists, storedRef, txType, storedAt, storedBy] = await ledger.verify(
        ethers.keccak256(ethers.toUtf8Bytes('never written')),
      );
      expect(exists).to.equal(false);
      expect(storedRef).to.equal(ethers.ZeroHash);
      expect(txType).to.equal(0);
      expect(storedAt).to.equal(0);
      expect(storedBy).to.equal(ethers.ZeroAddress);
    });
  });

  describe('audit roots', () => {
    const rootA = ethers.keccak256(ethers.toUtf8Bytes('root-a'));
    const rootB = ethers.keccak256(ethers.toUtf8Bytes('root-b'));

    it('anchors a root and records it by sequence', async () => {
      await expect(ledger.anchorAuditRoot(rootA, 10))
        .to.emit(ledger, 'AuditAnchored')
        .withArgs(rootA, 10, owner.address);

      expect(await ledger.auditRootAt(10)).to.equal(rootA);
      expect(await ledger.lastAnchoredSeq()).to.equal(10);
      expect(await ledger.auditAnchorCount()).to.equal(1);
    });

    it('refuses to rewind or repeat a sequence', async () => {
      await ledger.anchorAuditRoot(rootA, 10);
      await expect(ledger.anchorAuditRoot(rootB, 10)).to.be.revertedWithCustomError(ledger, 'NonMonotonicSeq');
      await expect(ledger.anchorAuditRoot(rootB, 9)).to.be.revertedWithCustomError(ledger, 'NonMonotonicSeq');
      await expect(ledger.anchorAuditRoot(ethers.ZeroHash, 11)).to.be.revertedWithCustomError(ledger, 'ZeroRoot');
    });

    it('requires a recorder wallet', async () => {
      await expect(
        ledger.connect(stranger).anchorAuditRoot(rootA, 5),
      ).to.be.revertedWithCustomError(ledger, 'NotRecorder');
    });
  });
});
