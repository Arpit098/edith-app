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

// Checked in order: the first that matches the summary (description or command) wins.
const BY_TEXT: [StepKind, RegExp][] = [
  ['test', /\b(test|tests|jest|pytest|make test|npm run check|tsc|typecheck|lint|unittest)\b/i],
  ['deploy', /\b(deploy|systemctl|restart|rollout|release|pm2|docker compose up)\b/i],
  ['git', /\b(git|gh|commit|push|pull request|PR|merge|rebase|branch|worktree)\b/],
  ['web', /\b(curl|wget|fetch|https?:\/\/)/i],
  ['search', /\b(find|search|grep|rg|look|list|ls|cat|read|view|show|check|inspect|head|tail|sed -n)\b/i],
  ['edit', /\b(edit|write|update|fix|rename|create|add|remove|delete)\b/i],
];

/** A step's kind from its tool and summary. */
export function stepKind(tool: string, summary: string): StepKind {
  const known = BY_TOOL[tool];
  if (known) return known;
  for (const [kind, re] of BY_TEXT) if (re.test(summary)) return kind;
  return 'other';
}

/** The summary as a step's label: no "$ " or "Edit: " prefix, one line. */
export function stepLabel(tool: string, summary: string): string {
  const s = summary.replace(/^\s*\$\s*/, '').replace(new RegExp(`^${tool}:\\s*`), '').split('\n')[0]!.trim();
  return s || tool;
}
