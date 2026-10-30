#!/usr/bin/env node
// The release notes of a main build (contracts/app-updates.md §2, `release_notes`): the "## Release
// notes" blocks of the PRs merged since the previous successful main build, deduplicated, plus the
// commit subjects as technical details. A PR without a block falls back to its title under
// "changes"; "Internal:" lines are left out.
//
//   node scripts/release-notes.js --repo owner/name --sha <this build's commit> --out <file>
//   node scripts/release-notes.js --empty --out <file>          (PR builds: no notes)
//
// Three GitHub calls, whatever the size of the release (previous build, compare, merged PRs), each
// with a timeout. It never fails the build: on any error it writes empty notes and a warning.

const { execFileSync } = require('child_process');
const fs = require('fs');

const MAX_ITEMS = 20; // per list
const MAX_DETAILS = 30;
const MAX_LINE = 160; // characters; the PR template asks for about 12 words
const HEADING = /^#{1,6}\s*release notes\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const LINE = /^(?:[-*]\s*)?(new|fix|fixes|internal)\s*:\s*(.+)$/i;

/** A PR body's "## Release notes" block -> {found, new: [], fixes: []} ("Internal:" lines dropped). */
function parseBlock(body) {
  const out = { found: false, new: [], fixes: [] };
  let inside = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (HEADING.test(line)) {
      inside = out.found = true;
      continue;
    }
    if (inside && ANY_HEADING.test(line)) break;
    const m = inside && LINE.exec(line);
    if (!m || /^<.*>$/.test(m[2].trim())) continue; // a template placeholder like <one plain sentence>
    const kind = m[1].toLowerCase();
    const text = m[2].trim().slice(0, MAX_LINE);
    if (kind === 'new') out.new.push(text);
    else if (kind === 'fix' || kind === 'fixes') out.fixes.push(text);
  }
  return out;
}

function pushUnique(list, seen, text, cap = MAX_ITEMS) {
  const key = text.toLowerCase().replace(/[.\s]+$/, '');
  if (!text || seen.has(key) || list.length >= cap) return;
  seen.add(key);
  list.push(text);
}

/**
 * @param {{title: string, body: string}[]} prs  merged PRs, oldest first
 * @param {string[]} subjects                    commit subjects, oldest first
 */
function collect(prs, subjects) {
  const notes = { new: [], fixes: [], changes: [], details: [] };
  const seen = { new: new Set(), fixes: new Set(), changes: new Set(), details: new Set() };
  for (const pr of prs) {
    const block = parseBlock(pr.body);
    if (block.found) {
      block.new.forEach((t) => pushUnique(notes.new, seen.new, t));
      block.fixes.forEach((t) => pushUnique(notes.fixes, seen.fixes, t));
    } else {
      pushUnique(notes.changes, seen.changes, String(pr.title || '').trim().slice(0, MAX_LINE));
    }
  }
  for (const s of subjects) {
    pushUnique(notes.details, seen.details, String(s || '').split('\n')[0].trim().slice(0, MAX_LINE), MAX_DETAILS);
  }
  return notes;
}

function empty() {
  return { new: [], fixes: [], changes: [], details: [] };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** What GitHub knows about this build: the PRs and commit subjects since the previous main build. */
function fromGitHub(repo, sha) {
  const runs = JSON.parse(
    gh(['run', 'list', '--repo', repo, '--workflow', 'build-apk.yml', '--branch', 'main', '--event', 'push',
      '--status', 'success', '--limit', '10', '--json', 'headSha']),
  );
  const previous = runs.map((r) => r.headSha).find((s) => s !== sha);
  let commits;
  if (previous) {
    commits = JSON.parse(gh(['api', `repos/${repo}/compare/${previous}...${sha}`,
      '--jq', '[.commits[] | {sha: .sha, subject: (.commit.message | split("\\n")[0])}]']));
  } else { // the first main build: just this commit
    commits = [{ sha, subject: gh(['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.message | split("\\n")[0]']).trim() }];
  }
  const shas = new Set(commits.map((c) => c.sha));
  const merged = JSON.parse(
    gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', 'main', '--limit', '100',
      '--json', 'number,title,body,mergeCommit,mergedAt']),
  );
  const prs = merged
    .filter((p) => p.mergeCommit && shas.has(p.mergeCommit.oid))
    .sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  return collect(prs, commits.map((c) => c.subject));
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--empty') out.empty = true;
    else if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  let notes = empty();
  if (!a.empty) {
    try {
      notes = fromGitHub(a.repo, a.sha);
    } catch (e) {
      console.log(`::warning::release notes skipped: ${String(e.message || e).split('\n')[0]}`);
    }
  }
  fs.writeFileSync(a.out, JSON.stringify(notes, null, 2) + '\n');
  console.log(`release notes: ${notes.new.length} new, ${notes.fixes.length} fixes, ${notes.changes.length} changes, ${notes.details.length} details`);
}

module.exports = { parseBlock, collect, empty };
