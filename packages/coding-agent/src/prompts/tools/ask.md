Ask the user a question when you need clarification or input during task execution.

## When to use

Use this tool to:
- Clarify ambiguous requirements before implementing
- Get decisions on implementation approach when multiple valid options exist
- Request user preferences (styling, naming conventions, architecture patterns)
- Offer meaningful choices about task direction

Do NOT use for:
- Questions resolvable by reading files or docs
- Permission for normal dev tasks (just proceed)
- Decisions you should make from codebase context

Tips:
- Place recommended option first with " (Recommended)" suffix
- 2-5 concise, distinct options
- Users can always select "Other" for custom input

<example>
question: "Which authentication method should this API use?"
options: [{"label": "JWT (Recommended)"}, {"label": "OAuth2"}, {"label": "Session cookies"}]
</example>
