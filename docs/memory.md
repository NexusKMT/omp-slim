# Automatic memory removal

OMP Slim does not run automatic long-term memory or lesson capture. Local summary memories, Hindsight, Mnemopi, Sharpshooter, automatic learning, memory tools, the `/memory` command, and `memory://` are removed.

Old configuration namespaces `memory`, `memories`, `hindsight`, `mnemopi`, `mnemosyne`, `sharpshooter`, and `autolearn` are ignored and removed when settings are saved. This migration handles both nested settings and quoted dotted keys. Existing memory databases, summaries, and skill files are left on disk; OMP Slim does not open, consolidate, or delete memory stores.

Session files, resume, history, compaction, and manually maintained `AGENTS.md` and `SKILL.md` instructions remain available. Existing managed skills are still discovered, and the explicit [`manage_skill`](tools/manage_skill.md) tool can create, update, or delete skills under the managed-skills directory. It performs no automatic capture or background model call.
