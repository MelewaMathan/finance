# Entity-relationship model

Fifteen tables in five groups: identity, lending, money, detection, and evidence. The model follows three
rules that explain most of its shape:

1. **Personal data is encrypted in place** (`*_enc`) and searchable only through a blind index (`*_bi`).
2. **Money is integer cents**, never a float; a schedule row and a payment row are separate facts.
3. **Evidence is append-only.** `audit_log` has no update path, and `actor_user_id` is deliberately *not* a
   foreign key so that deleting or suspending an account can never damage the trail.

```mermaid
erDiagram
    USERS ||--o| BORROWER_PROFILES : "has (borrowers)"
    USERS ||--o| STAFF_PROFILES : "has (staff metadata)"
    USERS ||--o{ REFRESH_TOKENS : "holds sessions"
    USERS ||--o{ LOANS : "legacy staff link (nullable)"
    USERS ||--o{ LOANS : "borrows (borrower_id)"
    LOANS ||--o{ LOAN_INSTALLMENTS : "scheduled as"
    LOANS ||--o{ TRANSACTIONS : "money movements"
    LOANS ||--o{ DOCUMENTS : "agreement, statements"
    LOANS ||--o{ CREDIT_SCORES : "scored by"
    LOANS ||--o{ FRAUD_FLAGS : "flagged on"
    TRANSACTIONS ||--o| FRAUD_FLAGS : "about"
    USERS ||--o{ FRAUD_FLAGS : "subject (borrower_id)"
    USERS ||--o{ FRAUD_FLAGS : "reviewed by"
    USERS ||--o{ ALERTS : "notified"
    USERS ||--o{ AUDIT_ANCHORS : "anchored by"
    USERS ||--o{ INTEGRITY_CHECKS : "run by"

    USERS {
        uuid id PK
        text email UK "stored lower-case (CHECK constraint)"
        text password_hash "bcrypt, cost 12"
        user_role role "borrower | staff | admin"
        text full_name
        user_status status "active | suspended | closed"
        integer failed_attempts
        timestamptz locked_until
        timestamptz last_login_at
        timestamptz created_at
        timestamptz updated_at
    }

    BORROWER_PROFILES {
        uuid user_id PK, FK
        text national_id_enc "AES-256-GCM ciphertext"
        text national_id_bi "HMAC-SHA256 blind index, indexed not unique"
        text phone_enc
        text phone_bi
        text date_of_birth_enc
        text address_enc
        text occupation "not sensitive enough to encrypt"
        bigint monthly_income_cents
        jsonb consent_flags
    }

    STAFF_PROFILES {
        uuid user_id PK, FK
        text staff_id
    }

    INSTITUTION_LOAN_SETTINGS {
        boolean id PK "singleton"
        integer interest_rate_bps
        bigint min_principal_cents
        bigint max_principal_cents
        integer max_installments
        text[] allowed_frequencies
        text institution_name
    }

    REFRESH_TOKENS {
        uuid id PK
        uuid user_id FK
        char token_hash UK "SHA-256 of the token, never the token"
        uuid family_id "rotation family, revoked on reuse"
        uuid replaced_by FK
        timestamptz expires_at
        timestamptz revoked_at
        inet ip
        text user_agent
    }

    LOANS {
        uuid id PK
        text ref UK "SMF-2026-000123"
        uuid lender_id FK "nullable legacy value; new loans leave it null"
        uuid borrower_id FK
        bigint principal_cents
        integer term_count
        repayment_frequency frequency "daily | weekly | monthly"
        integer rate_bps "0-10000"
        text purpose
        text collateral_desc
        text guarantor_name_enc "guarantor PII is encrypted too"
        text guarantor_phone_enc
        smallint guarantor_credit
        bigint total_repayable_cents
        loan_status status "pending .. settled"
        timestamptz identity_verified_at
        uuid identity_verified_by FK
        timestamptz decided_at
        uuid decided_by FK
        text decision_note
        uuid agreement_doc_id FK "documents.id"
        char agreement_sha256 "hash of the generated PDF"
        uuid score_snapshot_id "credit_scores.id at decision time"
        text held_reason
        timestamptz disbursed_at
        timestamptz settled_at
    }

    LOAN_INSTALLMENTS {
        uuid id PK
        uuid loan_id FK
        integer seq "UNIQUE (loan_id, seq)"
        date due_date
        bigint principal_due_cents
        bigint interest_due_cents
        bigint penalty_accrued_cents
        bigint paid_principal_cents
        bigint paid_interest_cents
        bigint paid_penalty_cents
        installment_status status "pending | partial | paid | overdue | waived"
    }

    TRANSACTIONS {
        uuid id PK
        uuid loan_id FK
        txn_type type "disbursement | repayment"
        bigint amount_cents "CHECK > 0"
        txn_method method "cash | mobile_money | bank"
        text mobile_txn_code
        text mobile_txn_code_norm "indexed; duplicate check"
        timestamptz occurred_at
        uuid recorded_by FK
        txn_status status "pending | held | cleared | rejected"
        text hold_reason
        numeric fraud_score "0-1, written by the model only"
        char canonical_payload_hash "SHA-256 of the canonical payload"
        char onchain_hash "hash written by LoanLedger"
        text onchain_tx_hash
        bigint onchain_block
        timestamptz onchain_recorded_at
        timestamptz verified_at
    }

    DOCUMENTS {
        uuid id PK
        uuid loan_id FK
        document_kind kind "agreement | statement | forensic_report"
        text mime
        text file_path
        char sha256 "hash of the stored file"
        uuid created_by FK
    }

    CREDIT_SCORES {
        uuid id PK
        uuid loan_id FK
        text model_version
        score_source model_source "ml_service | fallback_heuristic"
        integer score "0-100"
        risk_level risk_level "low | medium | high"
        jsonb features
        jsonb explanation "per-feature contribution"
        boolean advisory_only "always true"
        integer latency_ms
    }

    FRAUD_FLAGS {
        uuid id PK
        uuid loan_id FK
        uuid transaction_id FK
        uuid borrower_id FK
        flag_type flag_type
        flag_severity severity "low | medium | high | critical"
        flag_status status "open | cleared | confirmed"
        flag_source source "rule | ml"
        text rule_id
        jsonb detail "why it fired, with values"
        text dedupe_key UK "the same problem is reported once"
        timestamptz detected_at
        uuid reviewed_by FK
        timestamptz reviewed_at
        text resolution_note "mandatory at the API layer"
    }

    ALERTS {
        uuid id PK
        uuid user_id FK
        text type
        flag_severity severity
        text title
        text body
        text entity_type
        text entity_id "text, not uuid: alerts may point at anything"
        timestamptz read_at
    }

    AUDIT_LOG {
        bigint id PK
        bigint seq UK "gap-free order from sequence audit_seq"
        uuid actor_user_id "NO foreign key, on purpose"
        text actor_role
        text action "loan.disbursed, fraud.hold_released, ..."
        text entity_type
        text entity_id "text: loans, transactions, documents, ..."
        inet ip
        text user_agent
        text request_id "correlates with X-Request-Id"
        char before_hash
        char after_hash
        jsonb detail
        char prev_hash "previous row's row_hash"
        char row_hash UK "SHA-256 over this row incl. prev_hash"
        timestamptz created_at
    }

    AUDIT_ANCHORS {
        uuid id PK
        bigint upto_seq
        char chain_root "audit row hash at that seq"
        text onchain_tx_hash
        uuid anchored_by FK
        timestamptz created_at
    }

    INTEGRITY_CHECKS {
        uuid id PK
        integrity_scope scope "all | audit_chain | loan | entity"
        text target_id
        integer records_checked
        integer mismatches
        integrity_result result "ok | tampered | error"
        jsonb detail "chain verification + per-loan summary"
        uuid run_by FK
        timestamptz created_at
    }
```

## Reading the diagram

**Identity group.** `users` is the only table with a credential. Borrower and staff profiles are separate
one-to-one tables because their fields have nothing in common. Institution-wide terms live in the singleton
`institution_loan_settings` row, rather than in staff profiles.

**Why `*_bi` is indexed but not unique.** A duplicate national ID or phone number is a *fraud signal*, not a
database error. A unique constraint would reject the second account and hide the problem; the blind index lets
the identity-conflict rule find it and raise a `critical` flag while both accounts keep working.

**Lending group.** `loans` holds both the request (what the borrower asked for) and the outcome (rate, total,
status, who verified, who decided). The schedule lives in `loan_installments`; it is generated at application
time and regenerated on approval, so a rejected application still shows what it would have cost.

**Money group.** `transactions` is the only table where money moves, and it is deliberately small. It carries
three hashes with three different jobs:

| Column | Written when | Answers |
| --- | --- | --- |
| `canonical_payload_hash` | the payment is created | is this row still what it was? |
| `onchain_hash` | the ledger accepted the hash | did the ledger see it? |
| `onchain_tx_hash` | same write | which transaction proves it? |

**Detection group.** `fraud_flags.dedupe_key` is unique so re-running a scan cannot produce five copies of one
problem. `detail` is JSON because every rule explains itself differently — a reused receipt cites the other
loan, the model cites feature values — and the reviewer must be able to read the reason, not just the verdict.

**Evidence group.** `audit_log` is the spine. Its `row_hash` covers `prev_hash`, so the rows form a chain: edit
row 12 and rows 13…n no longer link, *and* row 12 no longer matches its own content. `integrity_checks` stores
what each run saw so a later reader can tell "verified on 3 Nov" from "verified now". `audit_anchors` records
where a chain root was written on-chain, which is what lets an admin say the log existed in that state at
that time even if the whole database were later replaced.

## Enumerated values

| Type | Values |
| --- | --- |
| `user_role` | `borrower`, `staff`, `admin` |
| `user_status` | `active`, `suspended`, `closed` |
| `loan_status` | `pending`, `under_review`, `approved`, `rejected`, `held`, `disbursed`, `active`, `settled`, `defaulted`, `cancelled` |
| `repayment_frequency` | `daily`, `weekly`, `monthly` |
| `installment_status` | `pending`, `partial`, `paid`, `overdue`, `waived` |
| `txn_type` / `txn_method` / `txn_status` | `disbursement`/`repayment` · `cash`/`mobile_money`/`bank` · `pending`/`held`/`cleared`/`rejected` |
| `risk_level` | `low`, `medium`, `high` |
| `score_source` | `ml_service`, `fallback_heuristic` |
| `flag_type` | `duplicate_txn_code`, `malformed_reference`, `identity_conflict`, `rapid_applications`, `ml_anomaly`, `duplicate_disbursement`, `hash_mismatch` |
| `flag_severity` / `flag_status` / `flag_source` | `low`…`critical` · `open`/`cleared`/`confirmed` · `rule`/`ml` |
| `integrity_scope` / `integrity_result` | `all`/`loan`/`entity`/`audit_chain` · `ok`/`tampered`/`error` |

## Constraints worth knowing

* `users_email_lowercase` — the API lower-cases emails; the schema enforces it, so two accounts cannot differ
  only by case.
* `loans_distinct_parties` — historical staff and borrower IDs cannot be equal; new loan rows use a null
  legacy staff link.
* `transactions_mobile_code_consistent` — a `mobile_money` payment must carry a reference; `cash` need not.
* All money columns are `CHECK (… >= 0)` or `> 0`; `fraud_score` is constrained to 0–1, so a bug that writes
  `7.5` fails at the database rather than in a report.
* `UNIQUE (loan_id, seq)` on installments and `UNIQUE (dedupe_key)` on flags are the two idempotency anchors of
  the system: a schedule cannot have two "installment 3"s and a problem cannot be reported twice.
