# Data flow diagrams

Three views, each answering a different question: **who talks to the system** (context), **what happens
inside** (level 1), and **where does personal data go** (classification). The classification table is the
important one: the whole design is an argument about the one boundary that must never be crossed.

## Level 0 — context

```mermaid
flowchart LR
    B["Borrower<br/>(individual)"]
    L["Staff<br/>(loan officer)"]
    A["Forensic admin<br/>(read-only)"]
    S["SecureMicrofinance<br/>0"]
    ML["ML service<br/>(FastAPI, internal)"]
    CH["LoanLedger<br/>(Hardhat / Polygon)"]

    B -->|"application, profile, repayment claims"| S
    S -->|"schedule, statement, score, proof badge"| B

    L -->|"decisions, disbursements, review notes"| S
    S -->|"book, alerts, fraud queue, proofs"| L

    A -->|"search filters, integrity runs, export requests"| S
    S -->|"audit rows, timelines, verification verdicts, files"| A

    S -->|"numeric features only"| ML
    ML -->|"score, risk, anomaly verdict"| S

    S -->|"record hash, loan-ref hash,<br/>type, timestamp, audit root"| CH
    CH -->|"exists / found / recorded-at"| S
```

Nothing external ever reaches the chain directly: only the API's recorder wallet signs. The ML service is an
internal component — it sees numbers derived from the loan, never identity fields.

## Level 1 — processes and stores

```mermaid
flowchart TB
    Z1["Borrower"] -->|credentials, application,<br/>repayment claim| P1
    Z2["Staff"] -->|credentials, verify note,<br/>decision, disbursement, review note| P1
    Z3["Admin"] -->|credentials, filters,<br/>integrity request| P1

    P1["1. Authenticate and authorise<br/>bcrypt · JWT · refresh rotation · RBAC"]
    P1 -->|"verified actor + role"| P2
    P1 -->|"verified actor + role"| P3
    P1 -->|"verified actor + role"| P5
    P1 -->|"verified actor + role"| P6
    P1 <-->|"users, sessions"| D1[("D1 users<br/>profiles (encrypted)")]
    P1 -->|"login, failure,<br/>rotation events"| D7[("D7 audit_log<br/>append-only")]

    P2["2. Loan lifecycle<br/>apply · verify · decide · agreement"]
    P2 <-->|"loans, installments"| D2[("D2 loans<br/>installments")]
    P2 -->|"PDF + SHA-256"| D4[("D4 documents<br/>file + hash")]
    P2 -->|"score request (7 features)"| P4
    P4["4. Credit scoring<br/>model or deterministic fallback"] -->|"score, risk, explanation"| P2
    P4 <-->|"snapshot"| D6[("D6 credit_scores")]
    P2 -->|"application, decision,<br/>agreement events"| D7

    P3["3. Money movement<br/>disburse · repay · hold"]
    P3 <-->|"transactions"| D3[("D3 transactions<br/>payload hash, on-chain proof")]
    P3 -->|"candidate movement<br/>(amount, code, hour, history)"| P3a["3a. Fraud screen<br/>rules R1–R5 + isolation forest"]
    P3a -->|"features"| ML["ML service"]
    ML -->|"is_anomaly, risk, severity"| P3a
    P3a -->|"flag, alert, hold reason"| D5[("D5 fraud_flags<br/>alerts")]
    P3 -->|"cleared payment hash"| P7["7. Ledger client<br/>record · verify"]
    P7 <-->|"hash-only records"| CH["LoanLedger"]
    P7 -->|"on-chain hash, block, timestamp"| D3
    P3 -->|"disbursement, repayment,<br/>hold events"| D7

    P5["5. Statements and proofs<br/>statement PDF/CSV · proof report"]
    P5 <-->|"schedule, payments"| D2
    P5 <-->|"payments, hashes"| D3
    P7 -->|"verdict per payment"| P5

    P6["6. Forensic views<br/>search · timeline · integrity · export"]
    P6 <-->|"rows, chain head"| D7
    P6 <-->|"loan + payment hashes"| D3
    P7 -->|"re-verify against chain"| P6
    P6 -->|"run result"| D8[("D8 integrity_checks")]
    P6 -->|"export files (CSV/PDF)"| Z3

    style D7 fill:#eef2ff,stroke:#4f46e5
    style D3 fill:#ecfdf5,stroke:#059669
    style CH fill:#fef3c7,stroke:#d97706
```

### Decomposition of process 3 (the money path)

```mermaid
flowchart LR
    IN["request<br/>amount, method, code"] --> V{"schema valid?<br/>zod"}
    V -- no --> R400["400 validation"]
    V -- yes --> T1["insert transaction<br/>status = pending"]
    T1 --> R1{"R1 duplicate<br/>receipt?"}
    R1 -- yes --> H["status = held<br/>hold_reason, flag, alert"]
    R1 -- no --> R2{"R2 forged<br/>pattern?"}
    R2 -- yes --> H
    R2 -- no --> R3{"R3 identity<br/>conflict?"}
    R3 -- yes --> H
    R3 -- no --> R4{"R4/R5 rapid apps<br/>or double disbursement?"}
    R4 -- yes --> H
    R4 -- no --> M{"model available?"}
    M -- no --> APPLY["apply: allocate installments<br/>under row locks"]
    M -- yes --> SC["/anomaly → risk"]
    SC -- "high / critical" --> H
    SC -- "low / medium" --> APPLY
    APPLY --> AN["anchor payload hash on-chain"]
    AN --> OK["status = cleared<br/>201 (or 202 when held)"]
    H --> W["staff review:<br/>release → APPLY<br/>reject → status = rejected"]
    W --> AUD["audit row"]
    OK --> AUD
```

`H` is the pivot of the whole module: the claim is recorded, the money has not moved, and only a human can
turn one into the other.

## Trust boundaries

| # | Boundary | Crossing | Control |
| --- | --- | --- | --- |
| B1 | Browser → API | Everything a user types | TLS, helmet, CORS allow-list, zod, rate limits, JWT + RBAC |
| B2 | API → PostgreSQL | SQL and parameters | Parameterised queries, least-privilege DB role, encryption of PII columns, append-only triggers |
| B3 | API → file store | Generated PDFs | Server-side rendering only, SHA-256 recorded per document, download audited |
| B4 | API → ML service | Derived numeric features | No identifiers sent; 3-second timeout; failure falls back deterministically |
| B5 | API → blockchain | **Hashes only** | Recorder allow-list on-chain; no update/delete functions; no PII in the payload |
| B6 | Admin → API | Read queries and export requests | Admin-only routes, every read audited, exports embed their own verification state |
| B7 | DBA → database | Direct SQL | Guard triggers block UPDATE/DELETE/TRUNCATE on `audit_log`; the hash chain exposes anyone who disables them |

## Data classification and where each item is allowed to go

| Data | Classification | PostgreSQL | API response | ML service | Ledger | Audit log |
| --- | --- | --- | --- | --- | --- | --- |
| Password | secret | bcrypt hash only | never | never | never | never |
| Refresh token | secret | SHA-256 only | httpOnly cookie | never | never | never |
| National ID, phone, DOB, address | personal (sensitive) | AES-256-GCM ciphertext + HMAC blind index | masked (`2345***89`) | never | never | field names only, never values |
| Guarantor name, phone | personal | ciphertext | masked | never | never | never |
| Full name, email | personal | plaintext (operational need) | to the counterparty and auditors | never | never | yes (actor name resolved at read time) |
| Loan amount, rate, schedule | financial | plaintext cents | to the two parties and auditors | **yes** (aggregated) | **no** (only a hash) | yes |
| Payment reference (M-Pesa code) | financial | plaintext + normalised | to the two parties and auditors | no | no | yes, inside `detail` |
| IP address, user agent | technical | plaintext | only to the admin | no | no | yes |
| Record hash, chain root | evidence | `char(64)` | yes | no | **yes** | yes (as `after_hash`) |
| Model risk score | derived | `numeric(5,4)` | yes | produces it | no | no (only the flag) |
| Fraud flag + reason | derived | jsonb | to the lender and admin | no | no | yes |

The chain column is the design's central claim: **every row before it may be rich; the chain may only ever
contain hashes and timestamps.** A public ledger that listed amounts would let anyone graph a borrower's
credit history — which, for a customer of an informal lender, is a safety problem, not just a privacy one.

## Retention

* `audit_log` is never deleted; there is no code path that would do it, and no role has the privilege.
* `refresh_tokens` accumulate as revoked rows: cheap, and they are the evidence for reuse detection.
* Documents are kept for the life of the loan plus whatever the lender's jurisdiction requires; a deletion
  would be an audited action in a real deployment (this prototype has no delete path at all).
* `integrity_checks` keeps every run; the history is how an admin shows the record was verified *then*, not
  only now.
