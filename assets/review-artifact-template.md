# Code Review: [{{REPO}} #{{PR_NUMBER}} — {{PR_TITLE}}]({{PR_URL}})

- **Author:** `{{AUTHOR}}` ({{REVIEW_MODE}})
- **Branch:** `{{HEAD_BRANCH}}` $\rightarrow$ `{{BASE_BRANCH}}`
- **Reviewed Commit:** `{{HEAD_SHA}}`
- **Jira Ticket:** [{{JIRA_KEY}}](https://ubitransport.atlassian.net/browse/{{JIRA_KEY}}) — *{{JIRA_SUMMARY}}*
- **Verdict Estimate:** {{VERDICT_BADGE}}

---

<!-- Include Section 0 ONLY when updating an existing review after new commits (`NEEDS_UPDATE`) -->
## 0. Incremental Update (`{{PREV_SHA}}` $\rightarrow$ `{{HEAD_SHA}}`)

- **New Commits Summary:** {{DELTA_SUMMARY}}
- **Resolved Findings from Previous Review:** {{RESOLVED_FINDINGS_LIST}}
- **Remaining / New Findings:** {{REMAINING_OR_NEW_FINDINGS_SUMMARY}}

---

## 1. Task Summary & Functional Problem Solved

- **Business & Functional Problem Solved:** {{BUSINESS_AND_FUNCTIONAL_PROBLEM_SUMMARY}}
- **Technical & Feature Solution:** {{TECHNICAL_AND_FEATURE_SOLUTION_SUMMARY}}
- **Jira & Scope Compliance:**
  - {{SCOPE_ALIGNMENT_NOTES}}
  - {{PR_SIZE_OR_CROSS_REPO_NOTES}}

---

## 2. Review Findings

> [!TIP]
> Reference findings by their `#ID` in the chat (e.g., *"Keep #1 and #3, #2 is a false positive because..."*) to trigger the continuous learning loop.

### 🔴 Blockers, Bugs & Functional Gaps

#### `#1` — [{{SHORT_TITLE}}](file://{{ABSOLUTE_FILE_PATH}}#L{{START_LINE}}-L{{END_LINE}})
- **Why it matters:** {{EXPLANATION_FOR_ANTOINE}}
- **Ready-to-paste GitHub comment:**
````markdown
{{GITHUB_COMMENT_IN_ANTOINE_VOICE}}
````

---

### 🟠 Architecture, Symfony & API Platform

#### `#2` — [{{SHORT_TITLE}}](file://{{ABSOLUTE_FILE_PATH}}#L{{START_LINE}}-L{{END_LINE}})
- **Why it matters:** {{EXPLANATION_FOR_ANTOINE}}
- **Ready-to-paste GitHub comment:**
````markdown
{{GITHUB_COMMENT_IN_ANTOINE_VOICE}}
````

---

### 🟡 Clean Code, Strong Typing & Testing

#### `#3` — [{{SHORT_TITLE}}](file://{{ABSOLUTE_FILE_PATH}}#L{{START_LINE}}-L{{END_LINE}})
- **Why it matters:** {{EXPLANATION_FOR_ANTOINE}}
- **Ready-to-paste GitHub comment:**
````markdown
{{GITHUB_COMMENT_IN_ANTOINE_VOICE}}
````

---

### 🔵 Nitpicks & Micro-Optimizations

#### `#4` — [{{SHORT_TITLE}}](file://{{ABSOLUTE_FILE_PATH}}#L{{START_LINE}}-L{{END_LINE}})
- **Why it matters:** {{EXPLANATION_FOR_ANTOINE}}
- **Ready-to-paste GitHub comment:**
````markdown
{{GITHUB_COMMENT_IN_ANTOINE_VOICE}}
````

---

### ❓ Domain / Edge-Case Questions

#### `#5` — [{{SHORT_TITLE}}](file://{{ABSOLUTE_FILE_PATH}}#L{{START_LINE}}-L{{END_LINE}})
- **Context:** {{EXPLANATION_FOR_ANTOINE}}
- **Ready-to-paste GitHub comment:**
````markdown
❓ Question: {{QUESTION_IN_ANTOINE_VOICE}}
````

---

## 3. Debrief Prompt (Continuous Learning)

Tell me in the chat:
1. **Which `#ID`s you reject** (and why $\rightarrow$ I will propose an entry in `false-positives.md`).
2. **What I missed or should phrase differently** ($\rightarrow$ I will propose an update to `reviewer-dna.md`).
