# Common Engineering Reviewer DNA (Cross-Team Baseline)

This file defines the shared cross-team code review baseline versioned in Git (`references/common-dna.md`).
Team-specific or personal rules are stored in `references/reviewer-dna.local.md` (gitignored so `git pull` never conflicts).

---

## 1. Architecture, Serialization & Clean Code

- **Single Responsibility & SOLID Orchestration:** Keep public service/handler methods focused on high-level orchestration and delegate distinct responsibilities (validation, mapping, external I/O) to dedicated collaborators or private methods.
- **Strict SRP & Dedicated Service Extraction:**
  - Avoid duplicating private helper methods across processors or controllers; extract shared business or mapping logic into a dedicated service or trait.

---

## 2. Multi-Tenant, Security & Voter Isolation (Critical)

- **Explicit Tenant & Access Control Verification:** Never trust unverified client identifiers or broad token types on sensitive endpoints; always enforce tenant isolation and expected user/service-account types in authenticators and voters.
- **Strict Authenticator & Voter Permission Checks:**
  - Always verify the exact authenticated user/service-account DTO type and tenant scope on endpoints and voters.

---

## 3. Database, Migrations & Performance

---

## 4. Language & Framework Idioms

---

## 5. Testing Standards (Unit & Functional)

---

## 6. Naming, Typos & Boy Scout Hygiene
- **Naming Consistency & Dead Code Removal:**
  - Keep method, variable, and class names domain-accurate in English and remove unused imports or dead code.

---

## 4. PHP 8.2+ & Symfony Idioms

- **Readonly Classes, Strong Typing & Constructor Promotion:**
  - Prefer readonly classes, promoted constructor properties, and strict non-nullable types on DTOs and services.
