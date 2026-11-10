# Comprehensive Code Review Checklist (`my-review`)

Apply this checklist systematically on every Pull Request diff in addition to the active **Common DNA**, **Team DNA**, and **Personal Local DNA** rules.

---

## 1. Functional Scope & Jira Alignment
- **Problem & Solution Clarity:** Does the PR solve the exact business and functional problem described in the linked Jira ticket and PR description?
- **Unintended Side Effects:** Could the change break existing callers, other tenants/customers, or backward compatibility on public/internal APIs?
- **Dead or Leftover Debug Code:** Ensure no debug tags (`@current`, `@only`), `var_dump`, `dd()`, `console.log`, or commented-out blocks remain in the diff.

---

## 2. Architecture, SOLID & Clean Code
- **Single Responsibility (SRP):** Keep controllers, command/message handlers, and UI components thin; delegate business logic to dedicated domain services.
- **Dependency Inversion (DIP):** Inject interfaces/contracts rather than concrete implementations where appropriate; avoid service locator anti-patterns.
- **Type Safety & Immutability:** Enforce strict typing (`declare(strict_types=1);` in PHP, avoid `any` in TypeScript), `readonly` properties on DTOs/value objects, and explicit return types.
- **Edge Cases & Null Safety:** Check for unguarded null/undefined dereferences, empty collections, division by zero, or missing array keys.

---

## 3. Database, Performance & Concurrency
- **N+1 Queries & Unbounded Fetches:** Flag loops executing queries or API calls (`findBy`, `getRepository`) and endpoints returning unpaginated collections.
- **Transaction Boundaries & Idempotency:** Verify that multi-step writes or external side effects (emails, message bus dispatches, payment gateways) handle retries and partial failures safely.
- **Migration & Schema Safety:** Ensure database migrations are reversible or safe for zero-downtime deployment (no unindexed foreign keys on large tables, no destructive column drops without deprecation).

---

## 4. Security & Multi-Tenancy
- **Authentication & Authorization:** Verify access control attributes/voters and tenant/customer isolation on every new or modified endpoint.
- **Input Validation & Injection:** Ensure all user inputs, query parameters, and payloads are validated; never interpolate raw strings into SQL/DQL or shell commands.
- **Sensitive Data Exposure:** Ensure secrets, tokens, passwords, or PII/PCI-DSS data are never logged or leaked in API responses/error messages.

---

## 5. Testing & Quality Assurance
- **Unit & Functional Coverage:** Every new business branch, validator, or bug fix should be covered by targeted unit and/or functional (Behat / Cypress / E2E) tests.
- **Test Cleanliness:** Use declarative fixture/DTO construction; clean up or isolate test data so tests are deterministic and order-independent.
- **Assertions:** Verify that tests assert not only HTTP status codes (`200`, `400`, `422`), but also the specific error messages or response payload state.
