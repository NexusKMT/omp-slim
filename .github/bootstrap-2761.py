#!/usr/bin/env python3
"""One-shot bootstrap for issue #2761 (self-removing; ASCII-only by design).

Applies four anchored edits to packages/coding-agent/src/modes/components/model-hub.ts:
  A. add #hiddenOptionalProviders / #reprobedHiddenProviders fields
  B. chain #reprobeHiddenOptionalProviders() after the offline hydration sync
  C. hide idle/unavailable optional discoverable providers in #buildSidebar
  D. add the #reprobeHiddenOptionalProviders() method

Fail-closed: every anchor must match exactly once or the script aborts
without writing anything.
"""

import sys

PATH = "packages/coding-agent/src/modes/components/model-hub.ts"

with open(PATH, encoding="utf-8") as f:
    src = f.read()

def insert_after(haystack: str, anchor: str, insertion: str) -> str:
    count = haystack.count(anchor)
    if count != 1:
        print(f"FATAL: anchor matched {count} times (expected 1): {anchor[:80]!r}")
        sys.exit(1)
    return haystack.replace(anchor, anchor + insertion, 1)

def replace_once(haystack: str, old: str, new: str) -> str:
    count = haystack.count(old)
    if count != 1:
        print(f"FATAL: segment matched {count} times (expected 1): {old[:80]!r}")
        sys.exit(1)
    return haystack.replace(old, new, 1)

# --- Edit A: fields -----------------------------------------------------------
src = insert_after(
    src,
    "\t#refreshSpinnerFrame = 0;\n\t#refreshSpinnerInterval?: Timer;\n",
    "\t// Optional discoverable locals (ollama, llama.cpp, lm-studio) hidden from\n"
    "\t// the sidebar because discovery found nothing at their endpoint (#2761).\n"
    "\t// Rebuilt on every sidebar build; consumed by the once-per-open re-probe.\n"
    "\t#hiddenOptionalProviders = new Set<string>();\n"
    "\t/** Providers already re-probed by {@link ModelHubComponent.#reprobeHiddenOptionalProviders} this hub open. */\n"
    "\t#reprobedHiddenProviders = new Set<string>();\n",
)

# --- Edit B: constructor chain ------------------------------------------------
src = replace_once(
    src,
    "\t\t\t\t.refresh(\"offline\")\n\t\t\t\t.then(() => this.#syncFromRegistryState())\n",
    "\t\t\t\t.refresh(\"offline\")\n\t\t\t\t.then(() => this.#syncFromRegistryState())\n"
    "\t\t\t\t.then(() => this.#reprobeHiddenOptionalProviders())\n",
)

# --- Edit C: #buildSidebar ----------------------------------------------------
src = insert_after(
    src,
    "\t#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {\n",
    "\t\tthis.#hiddenOptionalProviders.clear();\n",
)

src = replace_once(
    src,
    "\t\t\t\tif (authStorage.hasAuth(provider) || !locked.has(provider)) {\n"
    "\t\t\t\t\tlocked.delete(provider);\n"
    "\t\t\t\t\tunlocked.add(provider);\n"
    "\t\t\t\t}\n",
    "\t\t\t\tif (authStorage.hasAuth(provider) || !locked.has(provider)) {\n"
    "\t\t\t\t\t// #2761: implicit local endpoints (optional: true) stay hidden\n"
    "\t\t\t\t\t// until discovery actually reaches a server. \"idle\" means never\n"
    "\t\t\t\t\t// probed; \"unavailable\" means the endpoint is unreachable; both\n"
    "\t\t\t\t\t// would render a dead tab for a provider the user never\n"
    "\t\t\t\t\t// configured. models.yml discovery providers (optional: false)\n"
    "\t\t\t\t\t// and providers with stored auth keep their entry so\n"
    "\t\t\t\t\t// misconfigurations stay visible and diagnosable.\n"
    "\t\t\t\t\tif (!authStorage.hasAuth(provider)) {\n"
    "\t\t\t\t\t\tconst discovery = this.#registry.getProviderDiscoveryState(provider);\n"
    "\t\t\t\t\t\tif (discovery?.optional && (discovery.status === \"idle\" || discovery.status === \"unavailable\")) {\n"
    "\t\t\t\t\t\t\tthis.#hiddenOptionalProviders.add(provider);\n"
    "\t\t\t\t\t\t\tcontinue;\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tlocked.delete(provider);\n"
    "\t\t\t\t\tunlocked.add(provider);\n"
    "\t\t\t\t}\n",
)

# --- Edit D: re-probe method --------------------------------------------------
src = replace_once(
    src,
    "\t#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {\n",
    "\t/**\n"
    "\t * Background-probe optional discoverable providers hidden from the\n"
    "\t * sidebar (#2761). Runs once per provider per hub open, after the offline\n"
    "\t * hydration settles: when a previously dead local endpoint (ollama,\n"
    "\t * llama.cpp, lm-studio) is now serving models, the online refresh\n"
    "\t * repopulates the registry and the sync resurfaces its tab. Endpoints\n"
    "\t * still down keep their \"unavailable\" state and stay hidden.\n"
    "\t */\n"
    "\t#reprobeHiddenOptionalProviders(): void {\n"
    "\t\tif (this.#scopedModels.length > 0) return;\n"
    "\t\tfor (const provider of this.#hiddenOptionalProviders) {\n"
    "\t\t\tif (this.#reprobedHiddenProviders.has(provider)) continue;\n"
    "\t\t\tthis.#reprobedHiddenProviders.add(provider);\n"
    "\t\t\tvoid this.#refreshProviderInBackground(provider);\n"
    "\t\t}\n"
    "\t}\n"
    "\n"
    "\t#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {\n",
)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(src)

print("bootstrap-2761: all 5 edits applied")
