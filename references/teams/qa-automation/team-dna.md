# Team Reviewer DNA — QA & E2E Automation (Cypress / Behat)

Shared team-level code review rules for Cypress E2E and Behat functional test suites.

---

## 1. Deterministic E2E & Functional Testing

- **Ban Arbitrary `cy.wait(ms)` Sleeps:**
  - Never use hardcoded millisecond waits (`cy.wait(2000)`); synchronize on aliased network requests (`cy.intercept(...).as('req')` + `cy.wait('@req')`) or explicit DOM assertions.
- **Resilient Selectors & Scenario Isolation:**
  - Prefer `data-cy` attributes or semantic ARIA roles over fragile CSS class chains, and ensure each test scenario sets up its own state independently.
