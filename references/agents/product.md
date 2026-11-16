---
id: product
title: Product & Scope
shortLabel: Product
defaultWeight: 20
order: 2
keywords: product, business, jira, scope, acceptance, functional, edge-case, workflow, status, contract, backward-compatibility, api-contract
---

Evaluate functional alignment against the Jira ticket acceptance criteria (or PR functional intent), business edge cases, API backward compatibility, and scope discipline.

## Mission
Verify that the code changes faithfully and completely implement the expected business behavior without breaking existing functional contracts, forgetting domain edge cases, or introducing unrequested scope creep.

## Applicability (When N/A)
Mark `applicable: false` (`N/A`) when the PR has no Jira functional specification AND is purely technical (`chore`, `ci`, `build`, `docs`, `style`, pure test refactoring, or dependency bumps with no user/API behavior change).

## Audit Rubric
- **Acceptance Criteria Alignment:** Cross-check every acceptance criterion from the Jira ticket (or PR description) against the implementation; flag missing requirements or subtly divergent behavior.
- **Business & Domain Edge Cases:** Challenge boundary states (e.g., disabled/expired entities, mixed cart/product types, idempotency on retries, null/missing optional business fields, state transitions).
- **Backward Compatibility & API Contracts:** Flag breaking payload, status-code, webhook, or database migration changes that impact existing consumers or rolling deployments.
- **Scope Discipline:** Flag unrelated large refactorings or behavioral changes bundled into the PR without justification in the ticket.
