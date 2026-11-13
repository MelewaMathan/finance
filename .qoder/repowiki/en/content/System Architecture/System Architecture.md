# System Architecture

<cite>
**Referenced Files in This Document**
- [app.ts](file://backend/src/app.ts)
- [server.ts](file://backend/src/server.ts)
- [openapi.yaml](file://backend/openapi.yaml)
- [auth.routes.ts](file://backend/src/modules/auth/auth.routes.ts)
- [auth.service.ts](file://backend/src/modules/auth/auth.service.ts)
- [users.routes.ts](file://backend/src/modules/users/users.routes.ts)
- [users.service.ts](file://backend/src/modules/users/users.service.ts)
- [chain.client.ts](file://backend/src/modules/ledger/chain.client.ts)
- [audit.service.ts](file://backend/src/modules/audit/audit.service.ts)
- [rules.engine.ts](file://backend/src/modules/fraud/rules.engine.ts)
- [pool.ts](file://backend/src/db/pool.ts)
- [migrate.ts](file://backend/src/db/migrate.ts)
- [App.tsx](file://frontend/src/App.tsx)
- [api.ts](file://frontend/src/lib/api.ts)
- [docker-compose.yml](file://docker-compose.yml)
- [package.json](file://package.json)
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
SecureMicrofinance is a modular monolith that combines an Express.js backend API, a React frontend, and optional Ethereum blockchain integration. The system stores sensitive borrower data off-chain in PostgreSQL with encryption and blind indexes, while only transaction hashes and timestamps are anchored on-chain for tamper-evident proof. Cross-cutting concerns include JWT-based authentication, append-only hash-chained audit logging, and rule-based fraud detection. Deployment uses Docker Compose to run PostgreSQL, the API server, and a static web server serving the React application.

## Project Structure
The repository is organized as a Node.js workspace containing three main packages:
- `backend`: Express.js API with modules for authentication, users, ledger, audit, and fraud.
- `frontend`: React application with role-based pages and an API client.
- `contracts`: Hardhat project for the LoanLedger smart contract used by the backend.

```mermaid
graph TB
subgraph "Workspace"
Backend["backend (Express API)"]
Frontend["frontend (React SPA)"]
Contracts["contracts (Hardhat)"]
end
subgraph "Runtime"
Web["Nginx / Static Web Server"]
Api["Node API Server"]
DB["PostgreSQL"]
Chain["Ethereum RPC"]
end
Frontend --> Web
Web --> Api
Api --> DB
Api -. optional .-> Chain
Contracts --> Chain
```

**Diagram sources**
- [docker-compose.yml:1-52](file://docker-compose.yml#L1-L52)
- [package.json:1-37](file://package.json#L1-L37)

**Section sources**
- [package.json:1-37](file://package.json#L1-L37)
- [docker-compose.yml:1-52](file://docker-compose.yml#L1-L52)

## Core Components
- Express application factory configures security headers, CORS, body parsing, request context, rate limiting, OpenAPI documentation, and route mounting.
- Authentication routes implement registration, login, refresh, logout, profile access, and password change with token rotation and session revocation.
- User profile routes encrypt sensitive fields before storage and mask them on read; they also integrate fraud identity checks.
- Ledger client integrates with an Ethereum smart contract to record hashes and verify existence.
- Audit service writes an append-only, hash-chained log with advisory locking and integrity verification.
- Fraud rules engine detects duplicate receipts, malformed references, identity conflicts, rapid applications, and duplicate disbursements.
- Database layer provides connection pooling, transactions, and migration execution.
- Frontend app defines protected routes per role and manages short-lived access tokens with cookie-backed refresh.

**Section sources**
- [app.ts:16-93](file://backend/src/app.ts#L16-L93)
- [auth.routes.ts:15-121](file://backend/src/modules/auth/auth.routes.ts#L15-L121)
- [users.routes.ts:19-108](file://backend/src/modules/users/users.routes.ts#L19-L108)
- [chain.client.ts:5-151](file://backend/src/modules/ledger/chain.client.ts#L5-L151)
- [audit.service.ts:7-191](file://backend/src/modules/audit/audit.service.ts#L7-L191)
- [rules.engine.ts:4-275](file://backend/src/modules/fraud/rules.engine.ts#L4-L275)
- [pool.ts:37-61](file://backend/src/db/pool.ts#L37-L61)
- [migrate.ts:5-69](file://backend/src/db/migrate.ts#L5-L69)
- [App.tsx:15-205](file://frontend/src/App.tsx#L15-L205)
- [api.ts:1-144](file://frontend/src/lib/api.ts#L1-L144)

## Architecture Overview
The system follows a modular monolith pattern:
- Client boundary: React SPA served by Nginx.
- API boundary: Express server exposing versioned REST endpoints under `/api/v1`.
- Data boundary: PostgreSQL for relational data, encrypted profiles, audit logs, and fraud flags.
- Blockchain boundary: Optional Ethereum integration for anchoring transaction hashes and verifying existence.

```mermaid
graph TB
Browser["Browser (React SPA)"]
Nginx["Nginx (Static Assets)"]
Express["Express App<br/>Security + CORS + Rate Limit"]
AuthRoutes["Auth Routes"]
UserRoutes["User Routes"]
AuditSvc["Audit Service"]
FraudRules["Fraud Rules Engine"]
LedgerClient["Ledger Client"]
Postgres["PostgreSQL"]
EthRPC["Ethereum RPC"]
Browser --> Nginx
Nginx --> Express
Express --> AuthRoutes
Express --> UserRoutes
AuthRoutes --> Postgres
UserRoutes --> Postgres
UserRoutes --> FraudRules
AuthRoutes --> AuditSvc
UserRoutes --> AuditSvc
LedgerClient --> EthRPC
LedgerClient --> Postgres
```

**Diagram sources**
- [app.ts:23-93](file://backend/src/app.ts#L23-L93)
- [auth.routes.ts:51-121](file://backend/src/modules/auth/auth.routes.ts#L51-L121)
- [users.routes.ts:38-108](file://backend/src/modules/users/users.routes.ts#L38-L108)
- [audit.service.ts:37-118](file://backend/src/modules/audit/audit.service.ts#L37-L118)
- [rules.engine.ts:54-275](file://backend/src/modules/fraud/rules.engine.ts#L54-L275)
- [chain.client.ts:54-151](file://backend/src/modules/ledger/chain.client.ts#L54-L151)
- [docker-compose.yml:23-48](file://docker-compose.yml#L23-L48)

## Detailed Component Analysis

### Request Flow: Registration and Login
This sequence shows how the React client interacts with the API, middleware, services, database, and audit subsystem during account creation and login.

```mermaid
sequenceDiagram
participant Client as "React Client"
participant Nginx as "Nginx"
participant Express as "Express App"
participant Auth as "Auth Routes"
participant Svc as "Auth Service"
participant DB as "PostgreSQL"
participant Audit as "Audit Service"
Client->>Nginx : POST /api/v1/auth/register
Nginx->>Express : Forward request
Express->>Auth : Route to /register
Auth->>Svc : register(input, context)
Svc->>DB : Insert user + profile
Svc->>Audit : recordAudit(action=auth.register)
Audit->>DB : Append hash-chained row
Svc-->>Auth : {user, accessToken, refresh}
Auth-->>Client : 201 JSON + Set-Cookie
Client->>Nginx : POST /api/v1/auth/login
Nginx->>Express : Forward request
Express->>Auth : Route to /login
Auth->>Svc : login(email, password, context)
Svc->>DB : Lookup user + compare hash
Svc->>Audit : recordAudit(action=auth.login or auth.login_failed)
Svc-->>Auth : {user, accessToken, refresh}
Auth-->>Client : 200 JSON + Set-Cookie
```

**Diagram sources**
- [auth.routes.ts:53-73](file://backend/src/modules/auth/auth.routes.ts#L53-L73)
- [auth.service.ts:61-112](file://backend/src/modules/auth/auth.service.ts#L61-L112)
- [auth.service.ts:114-198](file://backend/src/modules/auth/auth.service.ts#L114-L198)
- [audit.service.ts:37-94](file://backend/src/modules/audit/audit.service.ts#L37-L94)

**Section sources**
- [auth.routes.ts:53-73](file://backend/src/modules/auth/auth.routes.ts#L53-L73)
- [auth.service.ts:61-198](file://backend/src/modules/auth/auth.service.ts#L61-L198)
- [audit.service.ts:37-94](file://backend/src/modules/audit/audit.service.ts#L37-L94)

### Profile Update and Fraud Integration
Profile updates encrypt sensitive fields, create blind indexes, and trigger fraud checks for identity conflicts.

```mermaid
flowchart TD
Start(["PUT /api/v1/me/profile"]) --> Validate["Validate payload with Zod"]
Validate --> RoleCheck{"Role is borrower?"}
RoleCheck --> |No| Deny["Return forbidden"]
RoleCheck --> |Yes| Encrypt["Encrypt nationalId, phone, DOB, address"]
Encrypt --> BlindIndex["Compute blind indexes for duplicates"]
BlindIndex --> FraudCheck["detectIdentityConflicts()"]
FraudCheck --> Flag{"Flag raised?"}
Flag --> |Yes| Alert["Raise fraud flag"]
Flag --> |No| Skip["No action"]
Alert --> Persist["UPDATE borrower_profiles"]
Skip --> Persist
Persist --> Audit["auditRequest(profile.update)"]
Audit --> Response["Return masked profile summary"]
```

**Diagram sources**
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [rules.engine.ts:94-143](file://backend/src/modules/fraud/rules.engine.ts#L94-L143)
- [users.service.ts:19-59](file://backend/src/modules/users/users.service.ts#L19-L59)

**Section sources**
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [rules.engine.ts:94-143](file://backend/src/modules/fraud/rules.engine.ts#L94-L143)
- [users.service.ts:19-59](file://backend/src/modules/users/users.service.ts#L19-L59)

### Blockchain Ledger Integration
The ledger client optionally records hashes on Ethereum and verifies their existence.

```mermaid
sequenceDiagram
participant API as "API Layer"
participant Ledger as "Ledger Client"
participant Contract as "LoanLedger Contract"
participant RPC as "Ethereum RPC"
API->>Ledger : recordOnChain({loanRefHash, txType, occurredAt, recordHashHex})
Ledger->>Contract : record(loanRef, txType, occurredAt, recordHash)
Contract->>RPC : Send transaction
RPC-->>Contract : Receipt
Contract-->>Ledger : Tx hash + block number
Ledger-->>API : OnChainRecord
API->>Ledger : readOnChain(recordHashHex)
Ledger->>Contract : verify(recordHash)
Contract-->>Ledger : exists + metadata
Ledger-->>API : Record or null
```

**Diagram sources**
- [chain.client.ts:71-108](file://backend/src/modules/ledger/chain.client.ts#L71-L108)
- [chain.client.ts:130-151](file://backend/src/modules/ledger/chain.client.ts#L130-L151)

**Section sources**
- [chain.client.ts:5-151](file://backend/src/modules/ledger/chain.client.ts#L5-L151)

### Authentication Middleware and Token Refresh
The frontend holds a short-lived access token in memory and uses an httpOnly refresh cookie to rotate sessions.

```mermaid
sequenceDiagram
participant SPA as "React SPA"
participant API as "Express App"
participant Auth as "Auth Routes"
participant Token as "Token Service"
participant DB as "PostgreSQL"
SPA->>API : GET /api/v1/auth/me (Bearer token)
API->>Auth : requireAuth()
Auth->>Token : verifyAccessToken(token)
Token-->>Auth : Payload
Auth->>DB : Load user status
DB-->>Auth : Active user
Auth-->>SPA : 200 user + profile
SPA->>API : POST /api/v1/auth/refresh (httpOnly cookie)
API->>Auth : rotateRefreshToken()
Auth->>DB : Issue new refresh + revoke old
Auth-->>SPA : New access token + rotated cookie
```

**Diagram sources**
- [auth.routes.ts:75-108](file://backend/src/modules/auth/auth.routes.ts#L75-L108)
- [auth.service.ts:200-262](file://backend/src/modules/auth/auth.service.ts#L200-L262)
- [api.ts:81-144](file://frontend/src/lib/api.ts#L81-L144)

**Section sources**
- [auth.routes.ts:75-108](file://backend/src/modules/auth/auth.routes.ts#L75-L108)
- [auth.service.ts:200-262](file://backend/src/modules/auth/auth.service.ts#L200-L262)
- [api.ts:81-144](file://frontend/src/lib/api.ts#L81-L144)

### Audit Trail Integrity
The audit service ensures immutability through advisory locks and hash chaining, and supports integrity verification.

```mermaid
flowchart TD
Entry(["recordAudit(entry)"]) --> Lock["pg_advisory_xact_lock(CHAIN_LOCK)"]
Lock --> Prev["Read last seq + row_hash"]
Prev --> Compute["computeAuditRowHash(...)"]
Compute --> Insert["INSERT audit_log(prev_hash, row_hash, detail)"]
Insert --> Result(["{seq, rowHash}"])
Verify(["verifyAuditChain()"]) --> ReadAll["SELECT audit_log ORDER BY seq"]
ReadAll --> CheckPrev{"prev_hash matches expected?"}
CheckPrev --> |No| Mismatch1["Record broken_link mismatch"]
CheckPrev --> |Yes| Recompute["Recompute row_hash"]
Recompute --> CheckHash{"row_hash matches stored?"}
CheckHash --> |No| Mismatch2["Record hash_mismatch"]
CheckHash --> |Yes| Next["Advance expectedPrev"]
Mismatch1 --> Next
Mismatch2 --> Next
Next --> Summary(["ok, rowsChecked, headSeq, headHash, mismatches"])
```

**Diagram sources**
- [audit.service.ts:37-94](file://backend/src/modules/audit/audit.service.ts#L37-L94)
- [audit.service.ts:142-191](file://backend/src/modules/audit/audit.service.ts#L142-L191)

**Section sources**
- [audit.service.ts:37-94](file://backend/src/modules/audit/audit.service.ts#L37-L94)
- [audit.service.ts:142-191](file://backend/src/modules/audit/audit.service.ts#L142-L191)

### Fraud Detection Rules
Rule-based detection raises flags for duplicate receipts, malformed references, identity conflicts, rapid applications, and duplicate disbursements.

```mermaid
flowchart TD
Input(["Transaction or Profile Event"]) --> Normalize["Normalize inputs"]
Normalize --> R1R2["detectReferenceIssues()"]
Normalize --> R3["detectIdentityConflicts()"]
Normalize --> R4["detectRapidApplications()"]
Normalize --> R5["detectDuplicateDisbursement()"]
R1R2 --> Flags["raiseFlag(dedupeKey)"]
R3 --> Flags
R4 --> Flags
R5 --> Flags
Flags --> Alerts{"Cross-loan duplicate?"}
Alerts --> |Yes| Notify["alertLender()"]
Alerts --> |No| Done["Done"]
```

**Diagram sources**
- [rules.engine.ts:54-92](file://backend/src/modules/fraud/rules.engine.ts#L54-L92)
- [rules.engine.ts:94-275](file://backend/src/modules/fraud/rules.engine.ts#L94-L275)

**Section sources**
- [rules.engine.ts:54-92](file://backend/src/modules/fraud/rules.engine.ts#L54-L92)
- [rules.engine.ts:94-275](file://backend/src/modules/fraud/rules.engine.ts#L94-L275)

### Database Schema Management
Migrations are forward-only SQL files executed inside transactions and recorded in `schema_migrations`.

```mermaid
flowchart TD
Start(["runMigrations({reset})"]) --> Connect["pool.connect()"]
Connect --> EnsureTable["CREATE schema_migrations IF NOT EXISTS"]
EnsureTable --> Applied["Load applied migrations"]
Applied --> Iterate["Sort .sql files"]
Iterate --> Apply{"File already applied?"}
Apply --> |Yes| Next["Next file"]
Apply --> |No| Begin["BEGIN"]
Begin --> Exec["Execute SQL"]
Exec --> Commit["COMMIT + INSERT name"]
Commit --> Next
Next --> End(["Up to date"])
```

**Diagram sources**
- [migrate.ts:14-58](file://backend/src/db/migrate.ts#L14-L58)

**Section sources**
- [migrate.ts:14-58](file://backend/src/db/migrate.ts#L14-L58)

## Dependency Analysis
The backend’s runtime depends on configuration, database pool, middleware, module routers, and optional chain client. The frontend depends on routing, authentication context, and the API client.

```mermaid
graph LR
App["app.ts"] --> Server["server.ts"]
App --> AuthRoutes["modules/auth/auth.routes.ts"]
App --> UsersRoutes["modules/users/users.routes.ts"]
AuthRoutes --> AuthService["modules/auth/auth.service.ts"]
UsersRoutes --> UsersService["modules/users/users.service.ts"]
UsersRoutes --> FraudRules["modules/fraud/rules.engine.ts"]
AuthRoutes --> AuditSvc["modules/audit/audit.service.ts"]
UsersRoutes --> AuditSvc
App --> ChainClient["modules/ledger/chain.client.ts"]
Services["Services"] --> Pool["db/pool.ts"]
Services --> Migrate["db/migrate.ts"]
Frontend["frontend/src/App.tsx"] --> ApiClient["frontend/src/lib/api.ts"]
```

**Diagram sources**
- [app.ts:1-93](file://backend/src/app.ts#L1-L93)
- [server.ts:1-26](file://backend/src/server.ts#L1-L26)
- [auth.routes.ts:1-121](file://backend/src/modules/auth/auth.routes.ts#L1-L121)
- [users.routes.ts:1-108](file://backend/src/modules/users/users.routes.ts#L1-L108)
- [pool.ts:37-61](file://backend/src/db/pool.ts#L37-L61)
- [migrate.ts:1-69](file://backend/src/db/migrate.ts#L1-L69)
- [App.tsx:1-205](file://frontend/src/App.tsx#L1-L205)
- [api.ts:1-144](file://frontend/src/lib/api.ts#L1-L144)

**Section sources**
- [app.ts:1-93](file://backend/src/app.ts#L1-L93)
- [server.ts:1-26](file://backend/src/server.ts#L1-L26)
- [auth.routes.ts:1-121](file://backend/src/modules/auth/auth.routes.ts#L1-L121)
- [users.routes.ts:1-108](file://backend/src/modules/users/users.routes.ts#L1-L108)
- [pool.ts:37-61](file://backend/src/db/pool.ts#L37-L61)
- [migrate.ts:1-69](file://backend/src/db/migrate.ts#L1-L69)
- [App.tsx:1-205](file://frontend/src/App.tsx#L1-L205)
- [api.ts:1-144](file://frontend/src/lib/api.ts#L1-L144)

## Performance Considerations
- Connection pooling: Use the provided pool utilities for efficient database access and safe transaction handling.
- Rate limiting: Global and auth-specific limits protect against abuse; write endpoints use additional throttling.
- Body size limit: JSON payloads are limited to reduce memory pressure.
- Off-chain-first design: Only hashes go on-chain to minimize latency and cost.
- Hash chaining: Advisory locks serialize audit writers to prevent chain forks.
- Frontend token management: In-memory access tokens and deduplicated refresh requests avoid redundant network calls.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
- Health check: Use `/api/health` to confirm service status, chain mode, and timestamp.
- OpenAPI docs: Access `/api/docs` and `/api/openapi.yaml` for endpoint specifications.
- Chain availability: If `CHAIN_MODE=off` or no contract address is configured, chain writes are disabled; operations remain functional but unanchored.
- Authentication errors: Generic messages prevent enumeration; check audit logs for failed attempts and lockouts.
- Profile updates: Ensure required fields meet validation rules; encrypted fields are masked on read.
- Fraud flags: Review flags and alerts for duplicate receipts, identity conflicts, rapid applications, and duplicate disbursements.
- Audit integrity: Run integrity checks to detect hash mismatches or broken links in the audit trail.
- Database migrations: Use the migration runner to apply SQL files; failures roll back individual migrations.

**Section sources**
- [app.ts:65-84](file://backend/src/app.ts#L65-L84)
- [chain.client.ts:24-41](file://backend/src/modules/ledger/chain.client.ts#L24-L41)
- [auth.service.ts:114-198](file://backend/src/modules/auth/auth.service.ts#L114-L198)
- [users.routes.ts:45-108](file://backend/src/modules/users/users.routes.ts#L45-L108)
- [rules.engine.ts:54-275](file://backend/src/modules/fraud/rules.engine.ts#L54-L275)
- [audit.service.ts:142-191](file://backend/src/modules/audit/audit.service.ts#L142-L191)
- [migrate.ts:14-58](file://backend/src/db/migrate.ts#L14-L58)

## Conclusion
SecureMicrofinance implements a secure, auditable microfinance platform with clear separation between business logic, data persistence, and optional blockchain anchoring. The modular monolith architecture keeps deployment simple while supporting strong security controls, comprehensive auditing, and fraud detection. Docker Compose provides a consistent local and CI environment, and the system is designed to scale horizontally at the API layer with stateless nodes behind a reverse proxy, while PostgreSQL and Ethereum RPC serve as external dependencies.

[No sources needed since this section summarizes without analyzing specific files]