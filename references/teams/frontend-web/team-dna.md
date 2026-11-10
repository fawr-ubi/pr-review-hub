# Team Reviewer DNA — Frontend Web (TypeScript / VueJS / Angular)

Shared team-level code review rules for Frontend Web applications.

---

## 1. Architecture, Serialization & Clean Code

- **Component Single Responsibility & Smart vs Presentational Separation:**
  - Keep UI components focused on presentation and user interaction; extract API orchestration, complex data transformations, and business state into composables (`use*`) or injectable services.
- **Strict TypeScript Typing (Zero `any`):**
  - Define explicit interfaces/types for all API payloads, component props, and emitted events; avoid `any` and unsafe `as` type assertions.

---

## 2. Reactivity, Performance & Memory Safety

- **Derived State via Computed / Signals Over Imperative Watchers:**
  - Prefer `computed` properties (or Angular Signals / `async` pipe) over manual `watch` / `subscribe` mutations that can cause cascading re-renders or stale state.
- **Subscription & Event Listener Cleanup:**
  - Always clean up manual DOM listeners, timers, and RxJS subscriptions on component unmount (`onUnmounted` / `takeUntilDestroyed`).

---

## 3. Accessibility & UX Consistency

- **Semantic HTML, Keyboard Navigation & Loading/Error States:**
  - Use semantic buttons/inputs with accessible labels, preserve keyboard focus order, and handle loading, empty, and error states explicitly.

---

## 4. Testing Standards (Vitest / Jest / Cypress)

- **User-Centric Assertions & Deterministic Async Tests:**
  - Test component behavior through user-visible outputs and emitted events rather than internal private state, and await asynchronous transitions deterministically without arbitrary `setTimeout` sleeps.
