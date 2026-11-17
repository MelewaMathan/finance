# Threat model — STRIDE

Scope: the whole prototype as it is built — browser client, Express API, PostgreSQL, the ML service,
the `LoanLedger` contract, and the people who operate them. It is organised by **element** (a place where
a trust boundary is crossed), and every element gets one STRIDE table. The last section lists the
residual risks that are *accepted*, on purpose, with what would be needed to close them.

The point of writing this down is to avoid the usual security-report lie: a table of controls that
says everything is mitigated. Where a control does not exist, that is stated.

Terminology used below:

* **Flag** = a judgement that a pattern is suspicious. **Hold** = a fact that money has not moved. They
  are separate on purpose; clearing one never silently resolves the other.
* **Audit chain** = `audit_log`, append-only, each row's `row_hash` covering its own contents and the
  previous row's hash.
* **Anchored** = a hash exists on the public chain. **Verified** = the recomputed hash matches the stored
  one *and* the chain entry matches. These are never conflated in the UI or the API.

## 1. Assets

| Asset | Where it lives | If an attacker got it |
| --- | --- | --- |
| Password | `users.password_hash` (bcrypt, cost 12) | Offline cracking; every other account is one pivot away |
| Refresh token | `refresh_tokens.token_hash` (SHA-256), cookie | Session takeover for up to 7 days |
| Borrower identity (national ID, phone, DOB, address, guarantor) | AES-256-GCM ciphertext in `borrower_profiles`, HMAC blind indexes | Coercion, doxxing, and — for a borrower in an informal lending context — physical risk |
| Money movements | `transactions` (integer cents, payload hash, on-chain proof) | Disputing or inventing debts |
| Signed loan agreement | PDF in `storage/`, SHA-256 in `documents` | Substituting different terms after signing |
| Evidence chain | `audit_log` + on-chain anchors | Rewriting history: repudiating an approval, erasing a hold |
| Credit model and scores | `ml-service/model/*.joblib`, `credit_scores` | Gaming decisions; the model is the lender's second opinion |
| Availability of the API | — | A lender who cannot see a payment believes it was not made |

## 2. Elements and the boundary each one sits on

| Element | Boundary (see [DFD](DFD.md)) |
| --- | --- |
| E1 Login and session issuance | B1 |
| E2 Authorisation on every request | B1 |
| E3 Personal data at rest and in responses | B2 |
| E4 Loan lifecycle and agreements | B2, B3 |
| E5 Money movement and holds | B2 |
| E6 Audit log and evidence | B2, B7 |
| E7 Ledger client and contract | B5 |
| E8 Scoring and anomaly services | B4 |
| E9 Admin views and exports | B6 |
| E10 Build, configuration, operations | — |

## 3. Threats by element

Each row is one threat. "Residual" is what remains *after* the control in this repository — not what a
mature deployment would add.

### E1 · Login and session issuance

| # | STRIDE | Attack | Control in this repository | Residual |
| --- | --- | --- | --- | --- |
| A1 | S | Credential stuffing / password guessing | bcrypt cost 12; 5 failures → `locked_until` for 15 min → `423 LOCKED`; `authLimiter` 20 attempts / 15 min keyed on the client IP **plus** the submitted email | Distributed attempts across many IPs defeat a per-IP bucket. No MFA |
| A2 | S | Username enumeration | Unknown email still runs `bcrypt.compare` against a dummy hash; identical `401 Invalid email or password` | A locked account answers `423` instead of `401`, which reveals that the account exists. Deliberate trade-off (a real user must know why) |
| A3 | S | Account lockout used as a weapon | The per-(IP, email) bucket makes 5 wrong passwords cheap for an attacker | A targeted user can be locked out repeatedly. `423` is time-boxed, not permanent |
| A4 | S | Session fixation | The server mints both tokens; no client-supplied session id is ever trusted | — |
| A5 | S | Stolen access token (XSS) | Access token is held in memory only, never `localStorage`; 15-minute TTL; role and status re-read from the database on every request | XSS can still act *as* the user while the page is open. No CSP is applied to the API (it serves JSON) and the SPA ships no CSP header |
| A6 | S | Stolen refresh cookie | Opaque 48-byte token, stored only as SHA-256; `httpOnly`, `SameSite=Strict`, `Secure` under `NODE_ENV=production`, `Path=/api/v1/auth`; rotated on every use | An attacker who uses the stolen token *first* wins a fresh family. The victim's next refresh revokes it, but not before the attacker acts |
| A7 | S | Refresh-token replay (two devices, one token) | Rotation claims the row with a conditional `UPDATE ... WHERE revoked_at IS NULL`; exactly one caller wins. A replay inside 15 s whose replacement is still live is treated as a concurrent tab; anything else revokes the **whole family** | 15 s is a trade-off: shortening it makes real two-tab users log out, lengthening it widens the theft window |
| A8 | T | Forged or edited JWT | HS256 signature, `issuer`/`audience` checked, payload re-parsed with zod (`typ: 'access'`); expired, tampered and wrong-audience are indistinguishable to the caller | Secret strength is the only thing standing between an attacker and unlimited tokens. Minimum length is enforced (16 chars) but a weak secret is not rejected |
| A9 | T | Stale privilege after role change or suspension | `requireAuth` reloads `id, email, role, full_name, status` from `users` on **every** request; `status !== 'active'` → `403` | One extra query per request. Accepted |
| A10 | R | Denying that a login happened | Every success, failure, lockout and rotation is written to the audit chain with IP and user agent | IP is spoofable behind a proxy that does not strip `X-Forwarded-For` (`trust proxy` is 1 hop) |
| A11 | I | Password recovered from logs | Passwords are never logged; audit details carry the email and a reason, never the secret | — |
| A12 | D | Login endpoint flooded | `authLimiter`; global limiter 600 requests / 15 min | Limits are in-process; a second API replica doubles every bucket |
| A13 | E | User claims a role they were not granted | `register` accepts `borrower` freely and `staff` only with a valid invite code; there is no self-service path to `admin` (database-provisioned only); the role in the token is ignored in favour of the database | Any DBA can create an admin — that is the same trust as the database itself |

### E2 · Authorisation on every request

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| B1 | E | Borrower reads another borrower's loan | `loadVisibleLoan` scopes by `borrower_id`/`lender_id`; auditors see all; anything else is `404`, not `403` | — |
| B2 | E | Staff approves or disburses on another staff member's book | `requireRole('staff')` at the route **and** ownership re-check in the service; tested in `loans.test.ts` ("scopes the queue to each book") | — |
| B3 | E | Admin modifies money | No write route accepts `admin`; `denyAuditorWrites` is a redundant belt on the one route a shared middleware could have let through | An admin can mark **their own** alert as read (`alerts.user_id = actor.id`) — no money, no evidence is touched |
| B4 | E | Borrower marks their own loan as verified / approved | Decision endpoints are staff-only; identity verification is staff-only; the service also re-checks loan status transitions | — |
| B5 | I | Existence oracle via error codes | Hidden resources answer `404`; `403` is reserved for "you exist but may not do this" | Endpoint shape (e.g. `409` on a second decision) can still reveal that a resource exists to someone who can already see it |
| B6 | E | Role check bypassed by a new route | Roles are declared per route, so a forgotten gate is a code-review failure rather than a config gap. `rbac.test.ts` asserts 401/403/404 behaviour per role | No automated "every mutating route has a role" test |

### E3 · Personal data at rest and in responses

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| C1 | I | Database dump read offline | National ID, phone, DOB, address and guarantor details are AES-256-GCM ciphertext (`v1:iv:tag:data`); the key is not in the dump | A dump **plus** `FIELD_ENCRYPTION_KEY` is plaintext. Key custody is the whole control |
| C2 | I | PII in API responses | Responses carry `maskValue()` output (`2345***89`); the plaintext is decrypted only inside the service that needs it | A compromised API process decrypts whatever it wants. Encryption at rest is not encryption in use |
| C3 | I | PII in the audit log | Audit `detail` carries ids, field names and hashes — never a national ID, phone or address | This is a convention held by every `recordAudit` call site, not a schema constraint. A future call could leak a value |
| C4 | T | Ciphertext edited in the database | GCM authentication tag turns any edit into a hard failure rather than a garbage read | An edit is detected, not prevented |
| C5 | I | Duplicate detection leaks identities | Blind index is HMAC-SHA256 with a separate key over a normalised value (`2547…`), so the same phone always collides and different phones do not | Equality is still an oracle: two rows with the same index are the same person. That is the intended function |
| C6 | D | Key loss | — | Losing `FIELD_ENCRYPTION_KEY` makes every encrypted field unreadable. The `v1:` prefix allows a future keyring, but **no rotation tooling exists** |
| C7 | I | PII on the public chain | Only hashes and timestamps are ever sent (see E7) | — |

### E4 · Loan lifecycle and agreements

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| D1 | T | Lender changes the terms after signing | PDF is rendered server-side, its SHA-256 stored in `documents`, referenced by `loans.agreement_sha256`, and the download **recomputes** the digest of the bytes it is about to send; a mismatch refuses with `409` and writes `document.integrity_violation` to the audit chain | Someone with write access to both the file and the database can replace both. Only the on-chain anchor closes that |
| D2 | T | Borrower edits an application after approval | Status transitions are checked in the service (`pending → verified → approved/rejected → disbursed`); a second decision is a `409`; totals are recomputed server-side, never taken from the client | — |
| D3 | R | Lender denies having approved | `loan.approved` audit row with actor, IP, user agent and the agreement hash | — |
| D4 | I | Path traversal on the document download | `file_path` is resolved against the storage root and rejected if it escapes | `file_path` never comes from a request, so this is defence in depth |
| D5 | R | Same agreement served to a different loan | `/loans/:id/agreement` loads the loan first, then that loan's `agreement_doc_id` | — |
| D6 | D | File system full / storage gone | — | `fs.writeFileSync` fails and the approval transaction rolls back (bytes are rendered *before* the transaction), so the loan stays undecided rather than approved-without-agreement. There is no capacity monitoring |

### E5 · Money movement and holds

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| E1 | T | Replaying someone else's M-Pesa receipt | Rule R1 (duplicate receipt across loans), R2 (forged pattern), R3 (identity conflict); the movement is parked as `held` and only a lender can release it | Releasing a hold is a human decision with no second approver |
| E2 | T | Overpaying / negative amounts | Integer cents everywhere; zod bounds; the amount is re-checked against the outstanding balance **inside** `SELECT ... FOR UPDATE`, so two concurrent payments cannot both pass | — |
| E3 | T | Double disbursement | R5 duplicate-disbursement rule plus a status check; a repeat disbursement is refused | A clever client that races two different receipts still produces two movements; the rules flag it, they do not forbid it |
| E4 | T | Releasing a hold twice | Release requires `transactions.status = 'held'` and (for disbursement) `loans.status = 'held'`; the update is conditional and re-read | — |
| E5 | R | Borrower claims cash was paid but no record exists | Rejected movements are kept as `rejected`, never deleted — the claim and the refusal both stay visible | Out-of-band cash with no receipt is unprovable either way; that is a business-process problem, not an API one |
| E6 | I | Competitor infers a borrower's debts | Reads are scoped to the two parties and auditors | The public chain leaks the **existence and count** of movements per loan reference hash. Amounts are never on-chain |
| E7 | R | Held movement silently cleared | A cleared movement is anchored on-chain and audited; an unanchored payment is reported as `anchored_unchecked`, never as verified | — |
| E8 | T | Statement edited in transit | Statements are generated server-side per request; exports carry no client input beyond the loan id | — |

### E6 · Audit log and evidence

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| F1 | T | Editing an audit row | `BEFORE UPDATE`/`BEFORE DELETE`/`BEFORE TRUNCATE` triggers raise an exception; the hash chain would break anyway | A superuser can `ALTER TABLE audit_log DISABLE TRIGGER USER` — and can recompute the chain |
| F2 | T | Deleting the tail of the log | `prev_hash` chaining; `verifyAuditChain` reports the first mismatch; the admin UI shows the verdict and the row | Nothing at rest prevents the deletion, only detection |
| F3 | T | Rewriting the whole chain after tampering | Chain heads can be anchored on the public ledger; `anchorAuditRoot` is **monotonic**, so an older root cannot be re-anchored | Anchoring is manual (a lender-triggered endpoint), so tampering between the last anchor and detection is invisible until the next anchor |
| F4 | R | Repudiating an action | Actor id + role + IP + user agent + request id per row; rows are never updated, so the original claim survives | A shared login is a shared actor |
| F5 | I | Admin reads PII from the log | `detail` holds ids and hashes, not values; actor names are resolved at read time | — |
| F6 | I | Quiet mass exfiltration of the log | Exports are admin-only and each one writes `audit.exported` with a SHA-256 of the file | No alerting on export volume |
| F7 | T | Export claims "verified" when it was not | The CSV/PDF embed the chain verdict computed **at export time**, and the file's own SHA-256 is returned in `X-Document-SHA256` | The file is a snapshot; its claim is only as good as the check that produced it |
| F8 | D | Log growth | Indexed by `created_at` and GIN on `detail` | `audit_log` grows without bound by design. Retention is a hosting cost decision, not a feature |

### E7 · Ledger client and contract

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| G1 | S | Arbitrary wallet writes a record | `onlyRecorder` allow-list; the owner manages it with a key that never reaches the server | The backend's recorder key sits in `.env`. Theft of that file means forged-but-valid records until the owner revokes the wallet |
| G2 | T | Editing or deleting a record | No update or delete function, no upgrade proxy, records are immutable | — |
| G3 | T | Replaying a record hash | `AlreadyRecorded` revert; the contract refuses a second write of the same hash | — |
| G4 | T | Back-dating a record | `FutureTimestamp` guard (5-minute skew tolerance) | A **past** timestamp is the API's own claim. That is why the on-chain block time is stored next to it and shown in the UI |
| G5 | T | Pointing the API at the wrong contract | Every proof re-checks that the on-chain `loanRef` matches the local loan and reports `broken` otherwise | — |
| G6 | I | PII on a public ledger | Only `loanRef` hash, transaction type, timestamp and a payload hash are written | Loan-reference hashes are stable per loan, so movements can be linked to each other even without identity |
| G7 | D | Chain unreachable | Anchor failures are caught, logged and surfaced as `unanchored`; the API keeps working with `CHAIN_MODE=off` | A long outage means a long stretch of unanchored records |
| G8 | E | Server claims it anchored when it did not | `verified` requires the on-chain entry to exist **and** match; statuses are `verified`, `anchored_unchecked`, `unanchored`, `broken` | — |

### E8 · Scoring and anomaly services

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| H1 | I | Borrower identity leaves the API | Only 14 numeric features (and 7 for anomaly) are sent; the loan id is **not** included in either request | Feature vectors are still personal data in aggregate — they describe one person's finances |
| H2 | T | Model silently changed | Feature order is a contract checked at startup; a mismatch raises instead of scoring confidently wrong | Anyone who can write `model/*.joblib` controls every score — and `joblib.load` is code execution. File permissions are the control |
| H3 | T | Client steers its own score | Features are computed server-side from the database; the request body has no score field | — |
| H4 | D | ML service down | 3-second timeout, then a deterministic labelled fallback (`model_source`); the anomaly layer fails **open**, so rules still run | A fallback that is silently used weakens decisions; it is labelled in the row and the UI rather than hidden |
| H5 | E | A model decides a loan | The score is advisory; a human makes the decision; the loan row records who | A lender who rubber-stamps the score is a process failure the code cannot see |
| H6 | T | Adversarial evasion of the anomaly model | Rules R1–R5 are deterministic and independent of the model | The synthetic training set makes evasion trivially easy. Stated as a limitation, not defended |

### E9 · Admin views and exports

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| I1 | I | Admin exports the whole log | Admin-only routes; every search, timeline and integrity run is itself audited | An admin is trusted by definition; the log of their reads is the control, not prevention |
| I2 | R | Integrity check reports a false "all good" | A tampered result is a `200` **finding** with `result: tampered` and the mismatching row, not an error — so a failure cannot be mistaken for a transport problem | The check only sees what the database shows it |
| I3 | R | Check reports false alarms | An unanchored payment is reported as `anchored_unchecked`/`unanchored`, never as tampering | A chain outage will make every recent payment look unproven, correctly |
| I4 | D | Expensive export or wide search | Bounded `pageSize`, bounded date range, bounded history | No per-user quota on exports |
| I5 | T | Filter values injected into SQL | Every filter is a bound parameter; `%` and `_` in `q` are escaped so a search cannot become a wildcard scan | — |

### E10 · Build, configuration, operations

| # | STRIDE | Attack | Control | Residual |
| --- | --- | --- | --- | --- |
| J1 | S | Secrets committed | `.env` is git-ignored; `.env.example` holds placeholders only | Nothing scans for a leaked key, and the same placeholders are valid input if someone forgets to change them |
| J2 | T | Misconfiguration weakens security silently | `config/env.ts` validates with zod and **fails fast**; `FIELD_ENCRYPTION_KEY` must be 64 hex chars; bcrypt cost bounded 10–14 | `NODE_ENV=development` in production would disable the `Secure` cookie flag. The value is not cross-checked against the deployment |
| J3 | E | Supply chain | One root `package-lock.json`; containers install with `npm ci` | No dependency audit or lockfile review in a pipeline — there is no CI pipeline in this repository |
| J4 | D | Single point of failure | Health endpoints for the API and the ML service; graceful shutdown closes the pool | Single instance, in-memory rate limits, no queue. A restart is a short outage |
| J5 | R | Log forgery through headers | `request_id` is generated server-side | `user_agent` and `ip` are attacker-controlled strings and are stored as such |

## 4. Control → evidence

Every claim above that matters is exercised by a test. Counts are for the current tree.

| Control | Where it is proved |
| --- | --- |
| bcrypt login, lockout, generic 401, rotation, reuse detection, logout revocation | `backend/test/auth.test.ts` (9) |
| Role gates, cross-book 404s, admin read-only, suspended account | `backend/test/rbac.test.ts` (6) |
| AES-GCM round trip, tamper rejection, blind index normalisation, masking | `backend/test/encryption.test.ts` (5) |
| Chain append, hash linkage, trigger blocks UPDATE/DELETE, `verifyAuditChain` | `backend/test/audit.test.ts` (4) |
| Schedule maths, agreement hash, **download refuses a swapped file**, disbursement rules | `backend/test/loans.test.ts` (11) |
| Allocation under locks, overpayment `422`, penalties, statements | `backend/test/repayments.test.ts` (8) |
| Advisory score, labelled fallback, ML payload shape | `backend/test/scoring.test.ts` (5) |
| Proof states (`verified` / `unanchored` / `broken`), wrong-contract detection | `backend/test/ledger.test.ts` (7) |
| Rule flags, ML layer, hold release/reject, review queue, alert scoping | `backend/test/fraud.test.ts` (8) |
| Admin-only search, timeline, tamper detection, exports audited | `backend/test/forensics.test.ts` (7) |
| Recorder allow-list, replay rejection, immutability, monotonic anchoring | `contracts/test/LoanLedger.test.js` (9) |

Reproduce:

```powershell
npm.cmd test                 # 10 files, 70 API tests
npm.cmd run contract:test    # 9 contract tests
```

## 5. Residual risk register

Accepted, in order of how much they would matter in a real deployment. "Would close it" is what a
production build needs, not what this prototype claims.

| # | Risk | Severity | Why accepted here | Would close it |
| --- | --- | --- | --- | --- |
| R1 | A DBA can disable the audit triggers and recompute the chain | High | The prototype's threat model treats the database operator as trusted; the detection machinery is demonstrated instead | Anchor the chain head on a schedule (not by hand), and keep the anchor wallet key off the API host |
| R2 | Refresh-cookie theft wins a window before revocation | High | The rotation + family revocation is the point being demonstrated | Bind tokens to a device fingerprint; require re-authentication for money movement |
| R3 | No MFA, no step-up for approvals or holds | High | Out of scope for the brief | TOTP or WebAuthn for `lender`; step-up on release of a held movement |
| R4 | A single approver can release a held payment | High | The separation of flag and hold is the demonstrated property | Two-person approval above a threshold |
| R5 | PII is protected at rest but plaintext in the process, and one key protects everything | Medium | Key management is infrastructure, not application code | KMS/HSM with per-field keys and a rotation procedure using the `v1:` prefix |
| R6 | Rate limits are per-process | Medium | Single-instance deployment is assumed | Shared store (Redis) for the limiters |
| R7 | No CSP on the SPA; XSS would act as the user | Medium | The SPA is served by nginx in deployment and by Vite in development | A strict CSP with nonces, plus `Trusted Types` |
| R8 | The ML model is synthetic and trivially evadable | Medium | Honest limitation, stated in the README | Real repayment data, monitoring for drift, and a reviewed model promotion process |
| R9 | `joblib` deserialisation is code execution if the model file is writable | Medium | Files are only produced by this repository | Read-only model mount, checksum recorded in the image |
| R10 | The recorder wallet key sits in `.env` | Medium | A prototype has to keep it somewhere | KMS-backed signer or a signing sidecar |
| R11 | Audit log grows without bound | Low | Correctness over cost for a prototype | Partition by month, archive cold partitions, keep the hashes |
| R12 | No alerting, no metrics, no CI security stage | Low | Out of scope; the docs say so | Prometheus + alerts on `integrity_violation`, `auth.refresh_reuse_detected`, export volume; `npm audit` in CI |

## 6. Out of scope

Named here so nobody assumes coverage:

* Host compromise (root on the API or database host). At that point the attacker can read memory and
  mint tokens.
* The lender's own device. A keylogger defeats every control above.
* Smart-contract economic attacks. `LoanLedger` stores no value, so there is nothing to drain — but it
  also cannot enforce repayment.
* Regulatory obligations (data-subject export/erasure). There is deliberately no delete path for
  evidence, which would conflict with a naive erasure request and needs a legal decision, not code.
* Denial of service at the network layer.
