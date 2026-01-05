Performs string replacements in files with fuzzy whitespace matching.

Usage:
- You must use your read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- Fuzzy matching handles minor whitespace/indentation differences automatically - you don't need to match indentation exactly.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
