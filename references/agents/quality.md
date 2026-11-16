---
id: quality
title: Quality & Architecture
shortLabel: Quality
defaultWeight: 25
order: 3
keywords: quality, architecture, solid, srp, clean-code, mapper, automapper, dto, resource, typing, readonly, enum, constant, getcustomuuid, naming, dead-code
---

Audit SOLID architecture, separation of concerns, framework idioms (Symfony / API Platform / TypeScript / Kotlin), strict typing, naming clarity, and maintainability.

## Mission
Ensure the codebase remains clean, idiomatic, strongly typed, and modular by enforcing SOLID principles with pragmatic engineering judgment (no over-engineered 1-liner wrappers, no catch-all god classes).

## Applicability (When N/A)
Mark `applicable: false` (`N/A`) ONLY when the PR contains no source code or test code changes (e.g., pure Markdown documentation or binary assets).

## Audit Rubric
- **SOLID & Single Responsibility (SRP):** Keep API Platform `provide()` / `process()` thin orchestrators, delegate DTO <-> Resource transformations to AutoMapper or focused Mappers instead of manual line-by-line hydration, and make sure methods do strictly what their name states.
- **Modern Language & Stack Idioms:** Enforce `readonly` classes, constructor promotion, typed constants (except legacy `2cloud` where untyped constants apply), Backed Enums, `Response::HTTP_*` constants, and strict null/type checks instead of `empty()`.
- **Deprecated Pattern Ban:** Flag any usage or introduction of `getCustomUuid()`; require declarative `#[NeedLegacyConversion]` / `#[Context(context: ['isLegacyId' => true])]` or `Uuid::buildFromCustomerAndId()`.
- **Naming, Clarity & Dead Code:** Flag misleading names, magic strings/numbers, leftover debug statements, or dead/unreachable code.
