# Team Reviewer DNA — Popcorn & Backend PHP (Symfony / API Platform / 2cloud)

Shared team-level code review rules for PHP backend microservices (`2cloud-services`) and `2cloud`.

---

## 1. Architecture, Serialization & Clean Code

- **API Platform Resource vs DTO Separation & AutoMapper:**
  - Keep API Platform Resource classes declarative and delegate transformation to AutoMapper / dedicated Mappers rather than manual property-by-property hydration inside State Processors or Providers.
- **Deprecated `getCustomUuid()` Ban:**
  - Never introduce or use `getCustomUuid()`. Use `core-bundle` declarative attributes (`#[NeedLegacyConversion]` and `#[Context(context: ['isLegacyId' => true])]`) or `Uuid::buildFromCustomerAndId($customerShortname, $legacyId)`.

---

## 2. Multi-Tenant, Security & Voter Isolation (Critical)

- **Voter & Authenticator Token Type Verification:**
  - Verify the exact authenticated user or service-account DTO class in Symfony Voters and State Processors, and return `404 Not Found` (rather than `403 Forbidden`) on resource ownership checks when preventing cross-tenant resource enumeration.

---

## 3. Database, Migrations & Performance

- **Doctrine Lifecycle & Async Batching:**
  - Never call `$em->flush()` inside `postUpdate` lifecycle listeners (use `preUpdate` or explicit service orchestration), and keep `$asyncManager->await()` outside loops.

---

## 4. PHP 8.3+ & Symfony Idioms

- **Typed Class Constants, Backed Enums & Strict Comparisons:**
  - Explicitly type class constants (`public const string`, `private const int`), use backed Enums or `Response::HTTP_*` constants instead of magic strings/numbers, and ban `empty()` in favor of strict null/type checks.

---

## 5. Testing Standards (PHPUnit & Behat)

- **Declarative DTO Instantiation & Negative Path Coverage:**
  - Instantiate DTOs and mocks declaratively via constructor named arguments or raw JSON payload mapping (never assign properties line-by-line), and cover both nominal and error/exception paths in PHPUnit and Behat scenarios.
