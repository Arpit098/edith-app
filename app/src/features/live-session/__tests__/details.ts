// A GET /v1/status/details answer (contracts/status.md), shared by the status panel tests.

export const DETAILS = {
  ts: 1000,
  edith: {
    state: 'tool',
    tool: 'Bash',
    step: '$ npm test',
    since: 958,
    ref: 'r1',
    turn_started: 900,
    tmux: 'running',
    background: [{ id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 820 }],
  },
  lanes: { side: [{ ref: 's9', seconds: 12, step: null, summary: 'check the disk' }], max_side: 2, queued: 2, approvals: 1 },
  session: { id: '8268e354-aaaa', title: 'Phase 2 app', started: 1_793_290_000, messages: 157, context_tokens: 320_562 },
  agents: [
    { name: 'edith-dev', dir: 'edith-app', branch: 'release-notes', state: 'busy', blocked: null, last: 'Running the tests', background: null },
    { name: 'edith-app', dir: 'edith-app-ui', branch: 'phase-2b', state: 'blocked', blocked: 'permission', last: null, background: null },
    { name: 'edith-ci', dir: 'edith-app-ci', branch: 'ci-fix', state: 'waiting', blocked: null, last: 'Watching CI', background: 'shell' },
  ],
  server: { tag: 'p1-live-7', started: 0, uptime: 51_234 },
};
