# Team Reviewer DNA — Mobile Android (Kotlin / WanFare / WanPay)

Shared team-level code review rules for Android Kotlin projects.

---

## 1. Architecture & Layer Isolation

- **Strict Domain / Data / Presentation Separation:**
  - Keep Domain UseCases and models free of Android framework or Retrofit/Room annotations; map Data DTOs to Domain models at repository boundaries.
- **Null Safety & Ban on Force-Unwrap (`!!`):**
  - Never use the `!!` operator in production code; handle nullable values with safe calls (`?.`), `?:`, `requireNotNull`, or sealed `Result` types.

---

## 2. Coroutines, Flow & Concurrency

- **Structured Concurrency & Dispatcher Injection:**
  - Inject coroutine dispatchers rather than hardcoding `Dispatchers.IO`, never use `GlobalScope`, and expose read-only `StateFlow` / `SharedFlow` from ViewModels.
