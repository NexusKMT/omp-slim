{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if skills.length}}
<skills>
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
</skills>
{{/if}}
