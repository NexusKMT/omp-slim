{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if toolInventory}}
{{toolInventory}}
{{/if}}
{{#if skills.length}}
<skills>
{{#each skills}}
- skill://{{name}}: {{description}}
{{/each}}
</skills>
{{/if}}
