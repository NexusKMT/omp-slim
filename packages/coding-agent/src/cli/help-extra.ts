import "@oh-my-pi/pi-utils/env";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Models")}
  OPENAI_API_KEY             - OpenAI GPT models (any models.yml provider also reads its own <PROVIDER>_API_KEY)
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  FIRECRAWL_API_KEY          - Firecrawl web search + fetch reader backend
  PARALLEL_API_KEY           - Parallel web search + fetch reader backend
  SEARXNG_ENDPOINT           - SearXNG instance endpoint

  ${chalk.dim("# Configuration")}
  OMP_PROFILE                 - Named profile for isolated agent state (same as --profile)
  Use \`omp --profile <name> --alias <command>\` to create a shell shortcut for a profile
  PI_CODING_AGENT_DIR        - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR             - Override package directory (for Nix/Guix store paths)
  PI_NO_PTY                  - Disable PTY-based interactive bash execution
  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  glob          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  task          - Launch sub-agents for parallel tasks
  todo          - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Plugin Options:")}
  --plugin-dir <path>        Load plugin from directory (repeatable)

${chalk.bold("Useful Commands:")}
  omp agents unpack           - Export bundled subagents to ~/.omp/agent/agents (default)
  omp agents unpack --project - Export bundled subagents to ./.omp/agents`;
}
