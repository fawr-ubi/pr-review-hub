---
id: testing
title: Testing & Reliability
shortLabel: Testing
defaultWeight: 15
order: 5
keywords: testing, test, phpunit, behat, vitest, jest, cypress, mock, stub, assertion, coverage, negative-path, constructor, fixture, over-testing, redundant-test, test-bloat, data-provider, pyramid
---

Assess right-sized automated test coverage (neither under-tested nor bloated), nominal + failure path verification, declarative test data construction, and assertion quality.

## Mission
Ensure every behavioral change or bug fix is backed by lean, reliable, high-signal automated tests (PHPUnit, Behat, Vitest/Jest, Cypress) that catch real regressions without brittle mock noise or redundant test bloat that slows down CI and maintenance.

## Applicability (When N/A)
Mark `applicable: false` (`N/A`) when the PR solely deletes already-unreferenced dead code, edits documentation/comments, or adjusts non-executable metadata where automated tests do not apply.

## Audit Rubric
- **Proportional Coverage (Nominal & Negative Paths):** Flag non-trivial business logic, Voter rules, or bug fixes missing unit/functional tests for both nominal execution and error/404/exception branches. Never demand tests on trivial code with no branching logic.
- **No Over-Testing & Test Pyramid Discipline (Anti-Bloat):** Flag redundant copy-pasted tests or combinatorial permutations exercising the exact same code branch (consolidate distinct equivalence partitions with `#[DataProvider]` / `it.each` and delete duplicates). Flag zero-ROI tests covering trivial DTOs/getters/enums or framework/Symfony/AutoMapper internals, and flag heavy Behat/E2E duplication of edge cases that belong in fast unit tests.
- **Declarative Test Data & Mock Hygiene:** Ban property-by-property mutation (`$dto->prop1 = ...; $dto->prop2 = ...;`) on DTOs, Resources, or stubs; require declarative named-argument constructors, `fromArray()`, or raw JSON payload mocking hydrated through the real Mapper/Serializer.
- **Meaningful Assertions:** Flag tautological tests that only assert mock call counts without verifying actual output state, response status, persisted data, or thrown domain exceptions.
