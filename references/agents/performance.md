---
id: performance
title: Performance & Scalability
shortLabel: Performance
defaultWeight: 15
order: 4
keywords: performance, scalability, sql, doctrine, n+1, query, index, migration, flush, postupdate, async, await, batch, memory, pagination, cache
---

Detect database bottlenecks, N+1 queries, missing indexes, Doctrine lifecycle traps, unbatched async/HTTP loops, and memory/payload inefficiencies.

## Mission
Protect production latency, database load, and worker memory under realistic multi-tenant traffic volumes.

## Applicability (When N/A)
Mark `applicable: false` (`N/A`) when the diff touches only documentation, static configuration, translations, pure unit test files, or trivial type annotations with zero runtime loop, I/O, query, or rendering impact.

## Audit Rubric
- **Database, Queries & Indexes:** Flag N+1 ORM lazy-loading in loops, unbounded `findAll()` / unpaginated queries, or new `WHERE` / `JOIN` / `ORDER BY` columns in migrations lacking supporting DB indexes.
- **Doctrine Lifecycle & Transaction Safety:** Never call `$em->flush()` inside `postUpdate` lifecycle listeners; avoid long-held DB transactions spanning external HTTP calls.
- **Async & External I/O Batching:** Keep `$asyncManager->await()` outside loops so concurrent promises run in parallel rather than sequentially.
- **Memory, Payloads & Rendering:** Flag full hydration of large datasets when scalar/stream iteration suffices, oversized API payloads, or avoidable frontend re-render cascades.
