---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### SecureMicrofinance
- Definition：Internal project codename for the university group prototype — a blockchain-backed microfinance platform targeting private individual moneylenders ('shylocks') and their borrowers, with roles Borrower, Moneylender, and Forensic Auditor.
- Aliases：SMF

### LoanLedger
- Definition：The Solidity smart contract whose sole purpose is to record SHA-256 hashes and timestamps of loan disbursements and repayments on Polygon; personal data never leaves the database.

### shylock
- Definition：Domain term for the target user class — a private individual moneylender who administers their own loan book. The system explicitly does NOT model banks, deposit-taking MFIs, or SACCOs.
- Aliases：moneylender

### Forensic Auditor
- Definition：Read-only role that inspects the immutable audit log, reconstructs event timelines per loan/borrower, and flags tamper mismatches between DB records and on-chain hashes.
- Aliases：auditor

### M0 / M1 / M2
- Definition：Module milestones used to phase delivery: M0 = skeleton + crypto/hash-chain libs + Docker scaffolding; M1 = database schema + auth (JWT refresh rotation, RBAC, audit chain); M2 = loan application → identity verification → decision with PDF agreement.
- Aliases：milestone 0、milestone 1、milestone 2

### refresh reuse grace window
- Definition：Auth policy: a replayed refresh token younger than `REFRESH_REUSE_GRACE_SECONDS` (default 15 s) is treated as a concurrent tab rather than theft, allowing two tabs to rotate without revoking the whole session family.
- Aliases：grace window、concurrent tab tolerance

### blind index
- Definition：HMAC-SHA256 pre-image of an encrypted sensitive field (national ID, phone) stored separately so equality lookups can be performed without decrypting the payload; collisions across accounts trigger an `identity_conflict` fraud flag.
- Aliases：hmac blind index
