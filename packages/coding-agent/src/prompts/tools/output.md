Read full agent/task output by ID.

Use when the Task tool's truncated preview isn't sufficient for your needs.
The Task tool already returns summaries with line/char counts in its result.

Parameters:
- ids: Array of output IDs (e.g., ["reviewer_0", "explore_1"])
- format: "raw" (default), "json" (structured object), or "stripped" (no ANSI codes)

Returns the full output content. For unknown IDs, returns an error with available IDs.

Example: { "ids": ["reviewer_0"] }
