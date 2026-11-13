// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LoanLedger
 * @notice Hash-only proof of microfinance disbursements and repayments.
 *
 * Design constraints, and why:
 *
 *  - Only a 32-byte hash and a timestamp are written. No names, no national
 *    IDs, no amounts. Everything personally identifying stays off-chain, so
 *    a public ledger cannot be used to profile a borrower.
 *  - A record hash can be written exactly once. Replaying the same payment
 *    proof is therefore impossible at the ledger layer, independent of the
 *    API's own duplicate checks.
 *  - Nobody -- including the owner -- can overwrite or delete a record.
 *    There is no update or delete function, and no upgrade proxy.
 *  - Only authorised recorder wallets may append. The owner manages that
 *    list; the backend holds one recorder key, not the owner key.
 *  - Audit-chain roots are anchored monotonically, so an auditor can prove
 *    the off-chain audit log existed in a given state at a given time.
 */
contract LoanLedger {
    struct Record {
        bytes32 loanRef;
        uint8 txType;
        uint64 occurredAt;
        address recorder;
    }

    /// @notice Owner manages the recorder allow-list.
    address public owner;

    /// @notice Number of records ever written.
    uint256 public recordCount;

    /// @notice Number of audit roots anchored.
    uint256 public auditAnchorCount;

    mapping(bytes32 => Record) private _records;
    mapping(bytes32 => bool) private _exists;
    mapping(address => bool) public isRecorder;

    /// @notice Audit-chain root for a given sequence number (0 = not anchored).
    mapping(uint256 => bytes32) public auditRootAt;

    /// @notice Highest sequence number anchored so far.
    uint256 public lastAnchoredSeq;

    event Recorded(
        bytes32 indexed recordHash,
        bytes32 indexed loanRef,
        uint8 txType,
        uint64 occurredAt,
        address indexed recorder
    );
    event AuditAnchored(bytes32 indexed root, uint256 uptoSeq, address indexed anchoredBy);
    event RecorderUpdated(address indexed recorder, bool allowed);

    error NotOwner();
    error NotRecorder();
    error AlreadyRecorded();
    error ZeroHash();
    error InvalidTxType();
    error FutureTimestamp();
    error ZeroLoanRef();
    error ZeroRoot();
    error NonMonotonicSeq();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRecorder() {
        if (!isRecorder[msg.sender]) revert NotRecorder();
        _;
    }

    constructor() {
        owner = msg.sender;
        isRecorder[msg.sender] = true;
        emit RecorderUpdated(msg.sender, true);
    }

    /**
     * @notice Append a proof for a disbursement (0) or repayment (1).
     * @param loanRef   Hash of the loan reference; never the reference itself.
     * @param txType    0 = disbursement, 1 = repayment.
     * @param occurredAt Unix seconds when the money moved off-chain.
     * @param recordHash SHA-256 of the canonical transaction payload.
     */
    function record(bytes32 loanRef, uint8 txType, uint64 occurredAt, bytes32 recordHash)
        external
        onlyRecorder
        returns (bytes32)
    {
        if (recordHash == bytes32(0)) revert ZeroHash();
        if (loanRef == bytes32(0)) revert ZeroLoanRef();
        if (txType > 1) revert InvalidTxType();
        // A small tolerance absorbs clock skew between the API host and node.
        if (occurredAt > block.timestamp + 5 minutes) revert FutureTimestamp();
        if (_exists[recordHash]) revert AlreadyRecorded();

        _records[recordHash] = Record({loanRef: loanRef, txType: txType, occurredAt: occurredAt, recorder: msg.sender});
        _exists[recordHash] = true;
        recordCount += 1;

        emit Recorded(recordHash, loanRef, txType, occurredAt, msg.sender);
        return recordHash;
    }

    /**
     * @notice Verify a proof. Returns zero values when it does not exist.
     */
    function verify(bytes32 recordHash)
        external
        view
        returns (bool found, bytes32 loanRef, uint8 txType, uint64 occurredAt, address recorder)
    {
        if (!_exists[recordHash]) return (false, bytes32(0), 0, 0, address(0));
        Record storage entry = _records[recordHash];
        return (true, entry.loanRef, entry.txType, entry.occurredAt, entry.recorder);
    }

    function exists(bytes32 recordHash) external view returns (bool) {
        return _exists[recordHash];
    }

    /**
     * @notice Anchor a root of the off-chain audit hash chain.
     * @dev Monotonic: a lower or equal sequence is rejected so history cannot
     *      be rewound by re-anchoring an older root.
     */
    function anchorAuditRoot(bytes32 root, uint256 uptoSeq) external onlyRecorder returns (bool) {
        if (root == bytes32(0)) revert ZeroRoot();
        if (uptoSeq <= lastAnchoredSeq) revert NonMonotonicSeq();

        auditRootAt[uptoSeq] = root;
        lastAnchoredSeq = uptoSeq;
        auditAnchorCount += 1;

        emit AuditAnchored(root, uptoSeq, msg.sender);
        return true;
    }

    /// @notice Owner authorises or revokes a backend recorder wallet.
    function setRecorder(address recorder, bool allowed) external onlyOwner {
        isRecorder[recorder] = allowed;
        emit RecorderUpdated(recorder, allowed);
    }
}
