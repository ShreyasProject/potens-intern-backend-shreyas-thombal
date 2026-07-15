# Tamper-Evident Audit Log Service

A backend service for recording **immutable, cryptographically verifiable audit logs**. Every entry is chained to the one before it using SHA-256 hashing, so any modification to historical data is immediately detectable. Built for systems that need a trustworthy, append-only record of events — payments, admin actions, compliance events, and more.

---

## 🚀 Features

| Feature | Details |
|---|---|
| 🔒 **Append-only records** | Log entries are immutable once written |
| ⛓️ **SHA-256 hash chaining** | Every entry references the previous entry's hash |
| 🔐 **ACID transactions** | PostgreSQL transactions guarantee atomic writes |
| 🔄 **Row-level locking** | Prevents concurrent requests from generating conflicting hash chains |
| ⚡ **Redis caching** | Cache-Aside pattern for frequently accessed read endpoints |
| 📨 **BullMQ background jobs** | Asynchronous chain verification and secondary processing |
| 🔍 **Tamper detection** | Full chain verification detects modifications instantly |
| 🗝️ **API key authentication** | Constant-time comparison prevents timing attacks |
| 📄 **Structured logging** | Pino JSON logs with sensitive header redaction |
| ✅ **Input validation** | Zod schema validation |
| 🚦 **Rate limiting** | Configurable fixed-window rate limiter |
| 📤 **JSON export** | Filtered export by actor and date range |
| 🐳 **Docker-first** | Docker Compose for PostgreSQL, Redis, and application |

---

## 🧱 Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 20.x |
| Framework | Express | 4.x |
| Database | PostgreSQL | 15.x |
| ORM | Prisma | 5.x |
| Cache | Redis | 7.x |
| Queue | BullMQ | 5.x |
| Validation | Zod | — |
| Logging | Pino | — |
| Containerization | Docker / Docker Compose | — |

### Why each technology is used

| Technology | Why it is used |
|---|---|
| **PostgreSQL** | ACID transactions, durable storage, row-level locking |
| **Prisma** | Type-safe ORM and transaction management |
| **Redis** | Read caching using the Cache-Aside pattern |
| **BullMQ** | Asynchronous background processing |
| **SHA-256** | Cryptographic tamper detection |
| **Docker** | Consistent development and deployment environment |

---

## 🏗️ Architecture

```
                 HTTP Request
                      │
                      ▼
          Middleware (Helmet, Auth, Validation)
                      │
                      ▼
                Controller Layer
                      │
                      ▼
                 Log Service
                      │
      ┌───────────────┼────────────────┐
      │               │                │
      ▼               ▼                ▼
 HashService     Redis Cache      BullMQ Queue
      │               │                │
      │               │          Background Worker
      │               │                │
      ▼               │        VerificationService
 PostgreSQL Transaction│
      │                │
      ▼                │
 ChainHead Row Lock     │
      │                │
      ▼                │
 LogEntry Insert        │
      │                │
      └──────► Commit ◄─┘
               │
               ▼
        Update Redis Cache
```

### Key Design Decisions

- Controllers remain thin and contain no business logic.
- Services encapsulate business logic.
- Repository encapsulates all database access.
- PostgreSQL is the single source of truth.
- Every log creation executes inside a PostgreSQL transaction.
- A row-level lock on `ChainHead` serializes concurrent writes and guarantees a linear hash chain.
- Redis follows the Cache-Aside pattern and is used only for read optimization.
- Redis is **never** used to determine the next `previousHash`.
- BullMQ handles asynchronous verification and other secondary tasks after a successful transaction commit.

---

## 🚀 Concurrency & Consistency

The service guarantees a linear, tamper-evident hash chain even when multiple clients create logs simultaneously.

Every log creation follows this flow:

```
Client
  │
  ▼
Validation
  │
  ▼
API Authentication
  │
  ▼
Begin PostgreSQL Transaction
  │
  ▼
Acquire Row Lock (SELECT ... FOR UPDATE)
  │
  ▼
Read latest hash from PostgreSQL
  │
  ▼
Generate SHA-256 hash
  │
  ▼
Insert LogEntry
  │
  ▼
Update ChainHead
  │
  ▼
Commit Transaction
  │
  ▼
Update Redis Cache
  │
  ▼
Enqueue BullMQ Verification Job
  │
  ▼
Return HTTP 201
```

### Why Redis is not used for writes

Redis is intentionally excluded from the write path. Reading the latest hash from Redis could allow concurrent requests to generate hashes from stale data. Instead, PostgreSQL remains the source of truth for all write operations. Redis is updated only after a successful transaction commit.

---

## ⚡ Redis Caching

Redis is used exclusively for read optimization. The project follows the **Cache-Aside pattern**.

Cached endpoints include:

- `GET /api/log/:id`
- `GET /api/logs`
- Dashboard latest log

Redis is never used when generating the next hash. If Redis becomes unavailable, the application automatically falls back to PostgreSQL without affecting correctness.

---

## 📨 Background Processing (BullMQ)

BullMQ is used for asynchronous work that should not increase API latency.

Current jobs include:

- Full chain verification
- Background integrity checks

Queue processing begins only after a successful database transaction. Queue failures never roll back committed log entries.

---

## 🔐 Security

- **API key authentication** using constant-time comparison to prevent timing attacks
- **Rate limiting** with a configurable fixed-window limiter
- **Input validation** via Zod schemas on every endpoint
- **Structured logging** with Pino, redacting sensitive headers (e.g. API keys, auth tokens)
- **Helmet** middleware for secure HTTP headers

---

## 📁 Project Structure

```
src/
├── controllers/
├── services/
│   ├── redis.service.js
│   ├── queue.service.js
│   ├── hash.service.js
│   ├── log.service.js
│   ├── verification.service.js
│   └── export.service.js
├── queues/
│   └── verification.queue.js
├── workers/
│   └── verification.worker.js
├── repositories/
├── middleware/
├── validators/
├── config/
└── app.js
```

---

## ⚙️ Environment Variables

| Variable | Required | Example | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | `postgresql://user:pass@postgres:5432/auditlog` | PostgreSQL connection string |
| `API_KEY` | ✅ | `your-secret-key` | Key required to authenticate API requests |
| `PORT` | — | `3000` | Port the server listens on |
| `REDIS_URL` | ✅ | `redis://redis:6379` | Redis connection string |
| `CACHE_TTL_SECONDS` | — | `600` | TTL for cached read responses |
| `QUEUE_CONCURRENCY` | — | `2` | BullMQ worker concurrency |

---

## 🐳 Running with Docker

The stack runs on **Postgres + Redis + BullMQ Worker + App**.

```bash
docker compose up --build
```

On startup, Docker Compose:

1. Starts PostgreSQL
2. Starts Redis
3. Waits for PostgreSQL to become healthy
4. Applies Prisma migrations
5. Starts the Express API
6. Starts the BullMQ worker

---

## 🧪 API Overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/log` | Create a new tamper-evident log entry |
| `GET` | `/api/log/:id` | Retrieve a single log entry |
| `GET` | `/api/logs` | List log entries (filterable) |
| `GET` | `/api/logs/verify` | Run full chain verification |
| `GET` | `/api/logs/export` | Export logs as JSON, filtered by actor and date range |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
