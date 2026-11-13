# Loan Application Workflow

<cite>
**Referenced Files in This Document**
- [openapi.yaml](file://backend/openapi.yaml)
- [002_loans.sql](file://backend/src/db/migrations/002_loans.sql)
- [users.routes.ts](file://backend/src/modules/users/users.routes.ts)
- [users.service.ts](file://backend/src/modules/users/users.service.ts)
- [rules.engine.ts](file://backend/src/modules/fraud/rules.engine.ts)
- [loans.ts](file://frontend/src/lib/loans.ts)
- [BorrowerDashboard.tsx](file://frontend/src/pages/borrower/BorrowerDashboard.tsx)
- [RegisterPage.tsx](file://frontend/src/pages/auth/RegisterPage.tsx)
- [App.tsx](file://frontend/src/App.tsx)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This document explains the end-to-end loan application workflow: borrower registration, profile completion with identity data, loan application submission, validation and fraud checks, lender review, and status transitions. It also documents the loan data model, eligibility rules, integration points with identity verification, and how applications are queued for lender review. The borrower’s dashboard experience is included to show how applicants track their applications and verification checklist.

## Project Structure
The loan workflow spans authentication, borrower profile management, loan application endpoints, fraud rule evaluation, database schema, and frontend pages.

```mermaid
graph TB
subgraph "Frontend"
RP["RegisterPage.tsx"]
BD["BorrowerDashboard.tsx"]
LT["lib/loans.ts"]
APP["App.tsx"]
end
subgraph "Backend API"
OA["openapi.yaml"]
UR["users.routes.ts"]
US["users.service.ts"]
RE["fraud/rules.engine.ts"]
DB["db/migrations/002_loans.sql"]
end
RP --> OA
BD --> LT
LT --> OA
APP --> BD
UR --> US
UR --> RE
OA --> DB
```

**Diagram sources**
- [RegisterPage.tsx:1-165](file://frontend/src/pages/auth/RegisterPage.tsx#L1-L165)
- [BorrowerDashboard.tsx:1-133](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L1-L133)
- [loans.ts:1-242](file://frontend/src/lib/loans.ts#L1-L242)
- [App.tsx:67-135](file://frontend/src/App.tsx#L67-L135)
- [openapi.yaml:1-286](file://backend/openapi.yaml#L1-L286)
- [users.routes.ts:1-108](file://backend/src/modules/users/users.routes.ts#L1-L108)
- [users.service.ts:1-60](file://backend/src/modules/users/users.service.ts#L1-L60)
- [rules.engine.ts:78-274](file://backend/src/modules/fraud/rules.engine.ts#L78-L274)
- [002_loans.sql:1-100](file://backend/src/db/migrations/002_loans.sql#L1-L100)

**Section sources**
- [openapi.yaml:1-286](file://backend/openapi.yaml#L1-L286)
- [App.tsx:67-135](file://frontend/src/App.tsx#L67-L135)

## Core Components
- Borrower registration and login via the public auth endpoints defined in the OpenAPI spec.
- Borrower profile update that encrypts sensitive fields (national ID, phone, date of birth, address), stores blind indexes for duplicate detection, and triggers identity conflict checks.
- Loan application submission through typed frontend helpers that call the loan endpoints.
- Fraud rules engine that evaluates identity conflicts, rapid applications, duplicate references, and duplicate disbursements.
- Database schema defining loan statuses, installments, and documents.
- Borrower dashboard showing verification checklist, recent applications, and outstanding balances.

**Section sources**
- [openapi.yaml:38-174](file://backend/openapi.yaml#L38-L174)
- [users.routes.ts:19-108](file://backend/src/modules/users/users.routes.ts#L19-L108)
- [users.service.ts:5-59](file://backend/src/modules/users/users.service.ts#L5-L59)
- [loans.ts:167-208](file://frontend/src/lib/loans.ts#L167-L208)
- [rules.engine.ts:94-274](file://backend/src/modules/fraud/rules.engine.ts#L94-L274)
- [002_loans.sql:5-100](file://backend/src/db/migrations/002_loans.sql#L5-L100)
- [BorrowerDashboard.tsx:1-133](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L1-L133)

## Architecture Overview
The loan application lifecycle flows from the frontend through authenticated API routes into service logic, database persistence, and fraud checks. Lenders review applications and make decisions; certain events trigger fraud flags that can hold approvals or disbursements.

```mermaid
sequenceDiagram
participant B as "Borrower"
participant FE as "Frontend<br/>RegisterPage / Dashboard"
participant API as "OpenAPI Endpoints"
participant U as "Users Service"
participant F as "Fraud Rules Engine"
participant DB as "Loans Schema"
B->>FE : Register account
FE->>API : POST /v1/auth/register
API-->>FE : Session + user
B->>FE : Update profile (ID, phone, income)
FE->>API : PUT /v1/me/profile
API->>U : Encrypt + blind-index fields
U->>F : detectIdentityConflicts(blind indexes)
F-->>U : Flags if conflicts found
U-->>FE : Masked profile summary
B->>FE : Submit loan application
FE->>API : POST /loans (typed payload)
API->>DB : Insert loan with status 'pending'
API-->>FE : Loan detail
Note over API,DB : Applications queue for lender review
```

**Diagram sources**
- [openapi.yaml:38-223](file://backend/openapi.yaml#L38-L223)
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [users.service.ts:19-59](file://backend/src/modules/users/users.service.ts#L19-L59)
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)
- [loans.ts:167-182](file://frontend/src/lib/loans.ts#L167-L182)

## Detailed Component Analysis

### Borrower Registration and Role Selection
- The registration form supports selecting borrower or lender role, collecting full name, email, password, and business name for lenders.
- On success, users are redirected to their role-specific home.

```mermaid
flowchart TD
Start(["Open Register Page"]) --> ChooseRole["Select role: borrower or lender"]
ChooseRole --> FillFields["Enter fullName, email, password, confirm"]
FillFields --> ValidateLocal["Client-side validation"]
ValidateLocal --> Submit["POST /v1/auth/register"]
Submit --> Redirect{"Role?"}
Redirect --> |borrower| GoBorrower["Navigate to /borrower"]
Redirect --> |lender| GoLender["Navigate to /lender"]
```

**Diagram sources**
- [RegisterPage.tsx:10-51](file://frontend/src/pages/auth/RegisterPage.tsx#L10-L51)
- [RegisterPage.tsx:53-165](file://frontend/src/pages/auth/RegisterPage.tsx#L53-L165)
- [openapi.yaml:38-80](file://backend/openapi.yaml#L38-L80)

**Section sources**
- [RegisterPage.tsx:10-51](file://frontend/src/pages/auth/RegisterPage.tsx#L10-L51)
- [RegisterPage.tsx:53-165](file://frontend/src/pages/auth/RegisterPage.tsx#L53-L165)
- [openapi.yaml:38-80](file://backend/openapi.yaml#L38-L80)

### Borrower Profile Completion and Identity Verification Integration
- Borrowers update national ID, phone, occupation, monthly income, date of birth, and address.
- Sensitive fields are encrypted at rest; blind indexes enable duplicate detection without decryption.
- Updating identity fields triggers fraud checks for cross-account identity conflicts.
- The profile summary returned to clients masks sensitive values.

```mermaid
flowchart TD
A["PUT /v1/me/profile"] --> B["Validate fields (Zod)"]
B --> C{"National ID provided?"}
C --> |Yes| D["Normalize + encrypt nationalId"]
D --> E["Store blind index national_id_bi"]
E --> F["detectIdentityConflicts(nationalIdBi)"]
C --> |No| G{"Phone provided?"}
G --> |Yes| H["Normalize + encrypt phone"]
H --> I["Store blind index phone_bi"]
I --> J["detectIdentityConflicts(phoneBi)"]
G --> |No| K["Update other fields"]
F --> L["Persist profile"]
J --> L
K --> L
L --> M["Return masked profile summary"]
```

**Diagram sources**
- [users.routes.ts:26-36](file://backend/src/modules/users/users.routes.ts#L26-L36)
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [users.service.ts:19-59](file://backend/src/modules/users/users.service.ts#L19-L59)
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)

**Section sources**
- [users.routes.ts:19-108](file://backend/src/modules/users/users.routes.ts#L19-L108)
- [users.service.ts:5-59](file://backend/src/modules/users/users.service.ts#L5-L59)
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)

### Loan Application Submission and Validation
- The frontend exposes a typed applyLoan function that posts a structured payload including lender selection, principal, term, frequency, purpose, optional collateral/guarantor details.
- The backend creates a loan record with an initial status of pending and generates a human-readable reference.

```mermaid
sequenceDiagram
participant FE as "Frontend"
participant API as "Loan Endpoints"
participant DB as "Loans Table"
FE->>API : POST /loans {lenderId, principalCents, termCount, frequency, purpose, ...}
API->>DB : INSERT loans (status = 'pending')
DB-->>API : Created loan row
API-->>FE : LoanDetail response
```

**Diagram sources**
- [loans.ts:167-182](file://frontend/src/lib/loans.ts#L167-L182)
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)

**Section sources**
- [loans.ts:167-182](file://frontend/src/lib/loans.ts#L167-L182)
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)

### Initial Fraud Checks on Application Events
- Identity conflict checks run when borrowers update national ID or phone.
- Rapid application detection counts recent applications per borrower within a configurable window.
- Duplicate mobile-money reference checks flag reused payment codes across transactions/loans.
- Duplicate disbursement checks prevent multiple disbursements for the same loan.

```mermaid
flowchart TD
Start(["Application or Transaction Event"]) --> Check1["Identity conflict?"]
Check1 --> |Yes| Flag1["Create flag: identity_conflict"]
Check1 --> |No| Check2["Rapid applications?"]
Check2 --> |Yes| Flag2["Create flag: rapid_applications"]
Check2 --> |No| Check3["Duplicate reference?"]
Check3 --> |Yes| Flag3["Create flag: duplicate_txn_code"]
Check3 --> |No| Check4["Duplicate disbursement?"]
Check4 --> |Yes| Flag4["Create flag: duplicate_disbursement"]
Check4 --> |No| Done(["No flags"])
```

**Diagram sources**
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)
- [rules.engine.ts:216-248](file://backend/src/modules/fraud/rules.engine.ts#L216-L248)
- [rules.engine.ts:187-214](file://backend/src/modules/fraud/rules.engine.ts#L187-L214)
- [rules.engine.ts:250-274](file://backend/src/modules/fraud/rules.engine.ts#L250-L274)

**Section sources**
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)
- [rules.engine.ts:187-214](file://backend/src/modules/fraud/rules.engine.ts#L187-L214)
- [rules.engine.ts:216-248](file://backend/src/modules/fraud/rules.engine.ts#L216-L248)
- [rules.engine.ts:250-274](file://backend/src/modules/fraud/rules.engine.ts#L250-L274)

### Loan Status Transitions and Eligibility Rules
- Loans start in pending state after submission.
- Additional states include under_review, approved, rejected, held, disbursed, active, settled, defaulted, cancelled.
- Installments track due dates, amounts, penalties, and payment progress.
- Documents such as agreements and forensic reports are attached to loans.

```mermaid
stateDiagram-v2
[*] --> pending
pending --> under_review : "Lender opens / identity verification"
under_review --> approved : "Decision : approve"
under_review --> rejected : "Decision : reject"
pending --> held : "Fraud gate triggered"
approved --> disbursed : "Disbursement completed"
disbursed --> active : "First repayment recorded"
active --> settled : "All installments paid"
active --> defaulted : "Repayment failure"
approved --> cancelled : "Cancellation"
rejected --> cancelled : "Cancellation"
held --> pending : "Review resolved"
```

**Diagram sources**
- [002_loans.sql:5-16](file://backend/src/db/migrations/002_loans.sql#L5-L16)
- [002_loans.sql:66-80](file://backend/src/db/migrations/002_loans.sql#L66-L80)
- [002_loans.sql:84-95](file://backend/src/db/migrations/002_loans.sql#L84-L95)

**Section sources**
- [002_loans.sql:5-16](file://backend/src/db/migrations/002_loans.sql#L5-L16)
- [002_loans.sql:66-80](file://backend/src/db/migrations/002_loans.sql#L66-L80)
- [002_loans.sql:84-95](file://backend/src/db/migrations/002_loans.sql#L84-L95)

### Application Data Model Structure
The core entities include loans, loan_installments, and documents. Key attributes capture parties, financial terms, compliance metadata, and lifecycle timestamps.

```mermaid
erDiagram
LOANS {
uuid id PK
text ref UK
uuid lender_id FK
uuid borrower_id FK
bigint principal_cents
integer term_count
enum frequency
integer rate_bps
text purpose
text collateral_desc
text guarantor_name_enc
text guarantor_phone_enc
smallint guarantor_credit
bigint total_repayable_cents
enum status
timestamptz identity_verified_at
uuid identity_verified_by
timestamptz decided_at
uuid decided_by
text decision_note
uuid agreement_doc_id FK
char(64) agreement_sha256
uuid score_snapshot_id
text held_reason
timestamptz disbursed_at
timestamptz settled_at
timestamptz created_at
timestamptz updated_at
}
LOAN_INSTALLMENTS {
uuid id PK
uuid loan_id FK
integer seq
date due_date
bigint principal_due_cents
bigint interest_due_cents
bigint penalty_accrued_cents
bigint paid_principal_cents
bigint paid_interest_cents
bigint paid_penalty_cents
enum status
timestamptz created_at
}
DOCUMENTS {
uuid id PK
uuid loan_id FK
enum kind
text mime
text file_path
char(64) sha256
uuid created_by
timestamptz created_at
}
LOANS ||--o{ LOAN_INSTALLMENTS : "has many"
LOANS ||--o{ DOCUMENTS : "has many"
```

**Diagram sources**
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)
- [002_loans.sql:66-80](file://backend/src/db/migrations/002_loans.sql#L66-L80)
- [002_loans.sql:84-95](file://backend/src/db/migrations/002_loans.sql#L84-L95)

**Section sources**
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)
- [002_loans.sql:66-80](file://backend/src/db/migrations/002_loans.sql#L66-L80)
- [002_loans.sql:84-95](file://backend/src/db/migrations/002_loans.sql#L84-L95)

### Borrower Dashboard Experience
- The dashboard shows a verification checklist (national ID, phone, occupation, monthly income).
- It displays recent applications with status badges and allows navigation to view all loans or apply for a new loan.
- Outstanding balance and active loan count are summarized.

```mermaid
flowchart TD
Load["Load BorrowerDashboard"] --> Fetch["listLoans(pageSize=50)"]
Fetch --> RenderStats["Render profile complete, monthly income, outstanding"]
RenderStats --> RenderList["Render recent applications with status badges"]
RenderList --> Checklist["Show verification checklist"]
Checklist --> Actions["Links: Apply for a loan, View all, Update profile"]
```

**Diagram sources**
- [BorrowerDashboard.tsx:12-43](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L12-L43)
- [BorrowerDashboard.tsx:44-133](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L44-L133)
- [loans.ts:153-165](file://frontend/src/lib/loans.ts#L153-L165)

**Section sources**
- [BorrowerDashboard.tsx:12-43](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L12-L43)
- [BorrowerDashboard.tsx:44-133](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L44-L133)
- [loans.ts:153-165](file://frontend/src/lib/loans.ts#L153-L165)

### Lender Review Queue and Decision Flow
- Applications are queued by default in pending state for lender review.
- Lenders can verify identity, decide approve/reject, and disburse funds.
- Frontend provides helper functions for listing lenders, applying, verifying, deciding, and disbursing.

```mermaid
sequenceDiagram
participant L as "Lender"
participant FE as "Frontend"
participant API as "Loan Endpoints"
participant DB as "Loans Table"
FE->>API : GET /lenders
API-->>FE : Lender options
FE->>API : POST /loans/{id}/verify {note}
API->>DB : Mark identity verified
API-->>FE : Updated loan
FE->>API : POST /loans/{id}/decision {decision, rateBps?, note}
API->>DB : Update status to approved/rejected
API-->>FE : Updated loan
FE->>API : POST /loans/{id}/disburse {method, mobileTxnCode?}
API->>DB : Set disbursed, write proof
API-->>FE : Disbursement result
```

**Diagram sources**
- [loans.ts:148-208](file://frontend/src/lib/loans.ts#L148-L208)
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)

**Section sources**
- [loans.ts:148-208](file://frontend/src/lib/loans.ts#L148-L208)
- [002_loans.sql:25-56](file://backend/src/db/migrations/002_loans.sql#L25-L56)

## Dependency Analysis
- Frontend components depend on typed API helpers for loan operations and route definitions for navigation.
- Backend user routes depend on crypto utilities for encryption and blind indexing, and on the fraud rules engine for identity conflict detection.
- Database schema defines constraints and indexes that support efficient querying by lender, borrower, and status.

```mermaid
graph LR
RP["RegisterPage.tsx"] --> OA["openapi.yaml"]
BD["BorrowerDashboard.tsx"] --> LT["loans.ts"]
LT --> OA
UR["users.routes.ts"] --> US["users.service.ts"]
UR --> RE["rules.engine.ts"]
OA --> DB["002_loans.sql"]
```

**Diagram sources**
- [RegisterPage.tsx:1-165](file://frontend/src/pages/auth/RegisterPage.tsx#L1-L165)
- [BorrowerDashboard.tsx:1-133](file://frontend/src/pages/borrower/BorrowerDashboard.tsx#L1-L133)
- [loans.ts:1-242](file://frontend/src/lib/loans.ts#L1-L242)
- [openapi.yaml:1-286](file://backend/openapi.yaml#L1-L286)
- [users.routes.ts:1-108](file://backend/src/modules/users/users.routes.ts#L1-L108)
- [users.service.ts:1-60](file://backend/src/modules/users/users.service.ts#L1-L60)
- [rules.engine.ts:78-274](file://backend/src/modules/fraud/rules.engine.ts#L78-L274)
- [002_loans.sql:1-100](file://backend/src/db/migrations/002_loans.sql#L1-L100)

**Section sources**
- [users.routes.ts:1-108](file://backend/src/modules/users/users.routes.ts#L1-L108)
- [loans.ts:1-242](file://frontend/src/lib/loans.ts#L1-L242)
- [002_loans.sql:1-100](file://backend/src/db/migrations/002_loans.sql#L1-L100)

## Performance Considerations
- Use indexed queries for lender and borrower lookups; the schema includes indexes on lender_id+status and borrower_id+created_at.
- Avoid decrypting sensitive fields in hot paths; rely on masked summaries and blind indexes for duplicate checks.
- Keep fraud rule evaluations lightweight and deduplicated using stable keys to prevent redundant alerts.
- Paginate loan listings to reduce payload size on the borrower dashboard.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
- Registration errors: Ensure passwords match and meet complexity requirements; check field-level error mapping.
- Profile update failures: Validate input lengths and formats; ensure at least one field is supplied; check for forbidden roles.
- Identity conflicts: If duplicate national ID or phone is detected, flags will be raised; resolve conflicts before approval.
- Application submission: Verify required fields (principal, term, frequency, purpose); ensure lender selection is valid.
- Status stuck in pending: Confirm lender has reviewed and made a decision; check for fraud holds that require resolution.

**Section sources**
- [RegisterPage.tsx:25-51](file://frontend/src/pages/auth/RegisterPage.tsx#L25-L51)
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [rules.engine.ts:94-112](file://backend/src/modules/fraud/rules.engine.ts#L94-L112)
- [loans.ts:167-182](file://frontend/src/lib/loans.ts#L167-L182)

## Conclusion
The loan application workflow integrates secure borrower registration, encrypted profile management, robust validation, and proactive fraud checks. Applications enter a pending queue for lender review, with clear status transitions and comprehensive auditability. The borrower dashboard provides transparency into verification completeness and application status, while the backend enforces data integrity and security through encryption, blind indexes, and constrained database schemas.

[No sources needed since this section summarizes without analyzing specific files]