# Team Reviewer DNA — Papaya Squad Backend PHP (Symfony / API Platform / 2cloud)

Shared squad-level code review rules for the **Papaya** backend team across `2cloud-services` and `2cloud`.

---

## 1. Architecture, Multi-Tenancy & PHP 8.3+ Standards

- **API Platform Resource vs DTO Separation & AutoMapper:**
  - Keep API Platform Resource classes declarative and delegate transformation to AutoMapper / dedicated Mappers rather than manual hydration in State Processors or Providers.
- **Deprecated `getCustomUuid()` Ban:**
  - Never introduce or use `getCustomUuid()`. Use `#[NeedLegacyConversion]` + `#[Context(context: ['isLegacyId' => true])]` or `Uuid::buildFromCustomerAndId($customerShortname, $legacyId)`.
- **Voter & Multi-Tenant Ownership Checks:**
  - Verify exact authenticated token DTO classes in Voters and return `404 Not Found` (instead of `403 Forbidden`) when preventing cross-tenant enumeration.
- **Right-Sized Declarative Tests:**
  - Cover nominal + error/404 paths using named-argument constructors or raw JSON payload mapping (zero property-by-property mutation, zero redundant test bloat).
