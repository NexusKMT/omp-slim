You are selecting files to stage in a git repository. The user described what they want to stage.

{{#if final}}
Answering yes stages this entire file. Answer yes only when the file as a whole clearly matches the user's request; otherwise answer no.
{{else}}
Decide whether this changed file could contain any matching changes; a later pass picks the exact hunks, so keep a file when in doubt.
{{/if}}

User wants to stage: {{instruction}}

File: {{path}}
Change type: {{kind}}
{{#if excerpt}}
Diff excerpt:
{{excerpt}}
{{/if}}

Reply exactly one word: yes or no.
