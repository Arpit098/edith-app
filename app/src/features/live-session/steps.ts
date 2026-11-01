// The Work card's steps in plain language (plans: work-card): what kind of step a tool call is, from
// its tool name and its summary (a Bash command's description, or the command itself), with an icon
// per kind. The "Bash $" / "Edit:" prefixes are dropped; the raw command stays for the detail view.

export type StepKind = 'search' | 'edit' | 'test' | 'git' | 'deploy' | 'web' | 'agent' | 'other';

export const STEP_ICON: Record<StepKind, string> = {
  search: 'magnify',
  edit: 'pencil',
  test: 'flask',
  git: 'source-branch',
  deploy: 'rocket',
  web: 'web',
  agent: 'robot',
  other: 'console',
};

const BY_TOOL: Record<string, StepKind> = {
  Read: 'search',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
};

const TEST = /\b(test|tests|jest|pytest|make test|npm run check|tsc|typecheck|lint|unittest)\b/i;
// "Find the failing tests", "ls __tests__": a look around, not a test run (unless it starts as one).
const LOOK = /\b(find|ls|grep|search|look|show|list|read)\b/i;
const RUNS = /^(run|npm|pytest|make test)\b/i;
const GIT = /\b(git|gh|commit|commits|committed|push|pull request|merge|rebase|branch|branches|worktree)\b/i;
const PR = /\bPRs?\b/; // capitals only: not "pr" in a word or a path

// Checked in order: the first that matches the summary (description or command) wins.
const BY_TEXT: [StepKind, (s: string) => boolean][] = [
  ['test', (s) => TEST.test(s) && (RUNS.test(s) || !LOOK.test(s))],
  ['deploy', (s) => /\b(deploy|deploys|deploying|redeploy|systemctl|restart|restarts|restarting|rollout|pm2|docker compose up|cut a release|release (v?\d|build))\b/i.test(s)],
  ['git', (s) => GIT.test(s) || PR.test(s)],
  ['web', (s) => /\b(curl|wget|fetch|https?:\/\/)/i.test(s)],
  ['search', (s) => /\b(find|search|grep|rg|look|list|ls|cat|read|view|show|check|inspect|head|tail|sed -n)\b/i.test(s)],
  ['edit', (s) => /\b(edit|write|update|fix|rename|create|add|remove|delete)\b/i.test(s)],
];

/** A step's kind from its tool and summary. */
export function stepKind(tool: string, summary: string): StepKind {
  const known = BY_TOOL[tool];
  if (known) return known;
  const s = summary.replace(/^\s*\$\s*/, '');
  for (const [kind, test] of BY_TEXT) if (test(s)) return kind;
  return 'other';
}

/** The summary as a step's label: no "$ " or "Edit: " prefix, one line. */
export function stepLabel(tool: string, summary: string): string {
  const s = summary.replace(/^\s*\$\s*/, '').replace(new RegExp(`^${tool}:\\s*`), '').split('\n')[0]!.trim();
  return s || tool;
}
