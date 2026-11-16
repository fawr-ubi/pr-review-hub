---
id: security
title: Security & Multi-Tenancy
shortLabel: Security
defaultWeight: 25
order: 1
keywords: security, tenant, isolation, customer, voter, auth, authenticator, permission, secret, token, credential, injection, sql, xss, csrf, locked, 404, 403
---

Check multi-tenant isolation, authentication/authorization boundaries, Symfony Voters, secrets exposure, and locked organization security policies.

## Mission
Audit every modified endpoint, State Provider, State Processor, Symfony Voter, Authenticator, repository query, and configuration file to guarantee zero cross-tenant data leakage, strict permission enforcement, and zero secret exposure.

## Applicability (When N/A)
Mark `applicable: false` (`N/A`) ONLY when the PR strictly modifies documentation (`.md`), static comments, or pure visual/translation assets with zero executable code, configuration, CI workflow, or query logic.

## Audit Rubric
- **Multi-Tenant & Resource Ownership Isolation:** Ensure queries, handlers, and processors scope data strictly to the current customer/tenant (`Customer`, `Uuid` vs `LegacyId`) and never allow cross-tenant enumeration.
- **Voter & Authenticator Rigor:** Verify exact authenticated user or service-account DTO classes in Symfony Voters/Processors, and return `404 Not Found` instead of `403 Forbidden` when preventing cross-tenant resource enumeration.
- **No Hardcoded Secrets or Sensitive Logs:** Flag any committed API key, token, password, private URL, or PII/credential leak in logs and error payloads.
- **Injection & Input Safety:** Flag unparameterized SQL/DQL, unsafe deserialization, path traversal, shell command injection, or unescaped HTML output.
