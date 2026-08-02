/**
 * Puppets — lifecycle reconciler.
 *
 * This module is the whole engine behind Puppets: a single, stateless pass that
 * walks a fleet of managed repositories and nudges every issue and pull request
 * one step further along the lifecycle. It is invoked by the reusable workflow
 * `puppets-reconcile.yml` through `actions/github-script`, which supplies the
 * `{ github, context, core }` toolkit (an authenticated Octokit, the workflow
 * context, and the Actions core helpers).
 *
 * State lives entirely in GitHub labels (`puppets:*`), so the reconciler holds no
 * database and can be re-run at any time: it simply re-derives where each item is
 * from its current label and picks up where it left off. Transitions are
 * forward-only, which makes repeated/overlapping runs safe.
 *
 * Lifecycle (one active label at a time):
 *   (no label) → needs-info → (cleared) → approved → curating → ready → claimed → in-review → done
 *   with side branches: needs-work (conflict remediation) and needs-human (escalation).
 *   In M1-parity mode (ENABLE_CURATION=false): approved → claimed directly.
 *
 * Security model: an issue's title/body are treated as untrusted data, never as
 * instructions. Nothing acts on an item until a human applies `puppets:approved`,
 * and even then the approval is re-verified — the approver must be allowlisted AND
 * currently hold write/triage access on that repo (see `validApproval`). A single
 * `puppets:no-auto` label takes an item completely out of scope.
 *
 * Configuration is passed entirely through environment variables (wired up by the
 * calling workflow):
 *   PUPPETS_OWNER            — the org/user that owns every managed repo.
 *   PUPPETS_REPOSITORIES     — newline-separated list of managed repo names.
 *   PUPPETS_APPROVAL_ACTORS  — newline-separated allowlist of logins permitted to approve.
 *   PUPPETS_INBOX_WORKFLOW_ID — this workflow's file id, used to find the previous run.
 *   MAX_ISSUES_PER_REPO      — cap on new Copilot assignments per repo per run.
 *   MAX_IN_FLIGHT_PER_REPO   — cap on claimed/in-review/needs-work issues per repo.
 *   CONFLICT_RETRIES         — how many times Copilot is asked to resolve a conflict
 *                              before the item is escalated to a human.
 *   INBOX_FALLBACK_HOURS     — lookback window for the "new issues" digest on the first run.
 *   PUPPETS_STALE_HOURS      — age threshold (in hours) after which an un-triaged issue is
 *                              re-surfaced in the digest as stale (default: 72).
 *   DRY_RUN                  — when 'true', log every intended mutation but write nothing.
 *   ENABLE_CURATION          — when 'false', skip curation and assign Copilot directly
 *                              (M1-parity mode). Any other value (default) enables M2
 *                              curation via GitHub Models before assigning Copilot.
 */
module.exports = async ({ github, context, core }) => {
  const fs = require('fs');
  // ── Configuration (all inputs arrive as environment variables) ──
  const owner = process.env.PUPPETS_OWNER.trim();
  const dryRun = process.env.DRY_RUN === 'true';
  const maxPerRepo = Number.parseInt(process.env.MAX_ISSUES_PER_REPO, 10);
  const maxInFlightPerRepo = Number.parseInt(process.env.MAX_IN_FLIGHT_PER_REPO, 10);
  // At least one conflict-resolution attempt; default to 2 when unset/invalid.
  const conflictRetries = Math.max(1, Number.parseInt(process.env.CONFLICT_RETRIES, 10) || 2);
  const repos = process.env.PUPPETS_REPOSITORIES.trim().split('\n').map(r => r.trim()).filter(Boolean);
  // The token's own identity — used to recognise comments/assignments this
  // automation itself created (so it updates its own markers rather than duplicating).
  const authenticatedUser = await github.rest.users.getAuthenticated();
  const automationLogin = authenticatedUser.data.login.toLowerCase();
  // Logins permitted to approve work. Membership here is necessary but NOT
  // sufficient — the approver's live repo permission is re-checked at approval time.
  const approvalActors = new Set(
    process.env.PUPPETS_APPROVAL_ACTORS
      .split('\n')
      .map(actor => actor.trim().toLowerCase())
      .filter(Boolean)
  );
  // Repo permission levels that count as "trusted enough to approve".
  const approvalPermissions = new Set(['admin', 'maintain', 'push', 'write', 'triage']);
  // Hidden HTML markers that let us find (and update in place) the single
  // instruction comment this automation posts for a given step.
  const implementationMarker = '<!-- puppets:implementation-instructions:v1 -->';
  const reviewMarker = '<!-- puppets:review-instructions:v1 -->';
  const curationMarker = '<!-- puppets:curation:v1 -->';
  // Every lifecycle label. Exactly one is active on an item at a time; `setState`
  // enforces that by removing the others. Order is informational only.
  const stateLabels = [
    'puppets:needs-info',
    'puppets:approved',
    'puppets:curating',
    'puppets:ready',
    'puppets:claimed',
    'puppets:needs-work',
    'puppets:in-review',
    'puppets:needs-human',
    'puppets:done',
  ];

  // Fail fast on misconfiguration rather than silently doing nothing / everything.
  if (!Number.isInteger(maxPerRepo) || maxPerRepo < 1) {
    throw new Error('max_issues_per_repo must be a positive integer');
  }
  if (!Number.isInteger(maxInFlightPerRepo) || maxInFlightPerRepo < 1) {
    throw new Error('max_in_flight_per_repo must be a positive integer');
  }
  if (!owner || repos.length === 0 || approvalActors.size === 0) {
    throw new Error('owner, repositories, and approval_actors must not be empty');
  }

  // ── Prompts & messages (kept out of this file) ──
  // Every piece of prose the engine emits — the LLM prompts it hands to Copilot for the
  // implementation and review steps, the conflict-remediation directive, and the
  // author-facing messages — lives under .github/puppets/prompts/ so the wording can be
  // edited without touching engine logic. They are read from the controller checkout; a
  // missing file degrades gracefully to empty text (that step simply posts nothing).
  const promptsDir = '.github/puppets/prompts';
  const loadPrompt = name => {
    try {
      return fs.readFileSync(`${promptsDir}/${name}.md`, 'utf8').trim();
    } catch (error) {
      core.warning(`Prompt file ${promptsDir}/${name}.md not found; using empty text.`);
      return '';
    }
  };
  // Fill {placeholders} in a template from a small map of values.
  const render = (template, values) =>
    template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
  const prompts = {
    implementation: loadPrompt('implementation'),
    review: loadPrompt('review'),
    conflict: loadPrompt('conflict'),
    needsInfo: loadPrompt('needs-info'),
    invalidApproval: loadPrompt('invalid-approval'),
    curation: loadPrompt('curation'),
  };

  // "Inbox" cutoff: surface issues filed since this workflow's previous run, so a
  // freshly filed issue is announced exactly once and old backlog is never swept.
  // Falls back to a fixed lookback when there is no prior run (e.g. the first run).
  const inboxFallbackHours = Math.max(1, Number.parseInt(process.env.INBOX_FALLBACK_HOURS, 10) || 24);
  // Stale threshold: un-triaged issues older than this are re-surfaced every run.
  const staleHours = Math.max(1, Number.parseInt(process.env.PUPPETS_STALE_HOURS, 10) || 72);
  const staleThreshold = new Date(Date.now() - staleHours * 3600 * 1000);
  let inboxSince;
  try {
    const { data: runList } = await github.rest.actions.listWorkflowRuns({
      owner: context.repo.owner,
      repo: context.repo.repo,
      workflow_id: process.env.PUPPETS_INBOX_WORKFLOW_ID,
      per_page: 20,
    });
    const prior = (runList.workflow_runs || [])
      .filter(run => run.id !== context.runId && run.run_started_at)
      .sort((a, b) => new Date(b.run_started_at) - new Date(a.run_started_at))[0];
    inboxSince = prior
      ? new Date(prior.run_started_at)
      : new Date(Date.now() - inboxFallbackHours * 3600 * 1000);
    console.log(`Inbox cutoff: issues filed after ${inboxSince.toISOString()}` +
      (prior ? ` (previous run #${prior.run_number})` : ' (fallback window)'));
  } catch (error) {
    inboxSince = new Date(Date.now() - inboxFallbackHours * 3600 * 1000);
    core.warning(`Could not read prior run time (${error.message}); using ${inboxFallbackHours}h fallback.`);
  }
  // ── Small pure helpers over the issue/label shapes the REST API returns ──
  const labelName = label => typeof label === 'string' ? label : label.name;
  const issueLabels = issue => new Set((issue.labels || []).map(labelName));
  // Skip issues opened by bots (including this automation) so we never act on our own noise.
  const isBotFiled = issue =>
    issue.user?.type === 'Bot' || issue.user?.login?.toLowerCase().endsWith('[bot]');
  // The (non-AI) triage bar: a body with at least a little substance.
  const hasEnoughDetail = issue => (issue.body || '').trim().length >= 40;

  // Add one label (honouring dry-run, which logs but writes nothing).
  async function addLabel(repo, issueNumber, label) {
    console.log(`  + ${label}`);
    if (!dryRun) {
      await github.rest.issues.addLabels({
        owner, repo, issue_number: issueNumber, labels: [label],
      });
    }
  }

  async function removeLabel(repo, issueNumber, label, labels) {
    if (!labels.has(label)) return;
    console.log(`  - ${label}`);
    if (!dryRun) {
      await github.rest.issues.removeLabel({
        owner, repo, issue_number: issueNumber, name: label,
      });
    }
  }

  async function setState(repo, issue, nextState) {
    const labels = issueLabels(issue);
    for (const label of stateLabels) {
      if (label !== nextState) {
        await removeLabel(repo, issue.number, label, labels);
      }
    }
    if (!labels.has(nextState)) {
      await addLabel(repo, issue.number, nextState);
    }
  }

  async function setPrState(repo, prNumber, nextState) {
    const { data: prAsIssue } = await github.rest.issues.get({
      owner, repo, issue_number: prNumber,
    });
    await setState(repo, prAsIssue, nextState);
  }

  async function setLinkedState(repo, issue, pr, nextState) {
    // Update the projection first. If PR labeling fails, the authoritative issue remains
    // in an active state and a later reconciliation can retry the repair.
    await setPrState(repo, pr.number, nextState);
    await setState(repo, issue, nextState);
  }

  // Write or update a comment using GraphQL mutations, which work with either
  // issues=write or pull_requests=write fine-grained PAT permissions (unlike the
  // REST issues comment endpoint, which specifically requires issues=write).
  async function writeComment(subjectNodeId, existingCommentNodeId, body) {
    if (existingCommentNodeId) {
      await github.graphql(`
        mutation($id: ID!, $body: String!) {
          updateIssueComment(input: { id: $id, body: $body }) {
            issueComment { id }
          }
        }`, { id: existingCommentNodeId, body });
    } else {
      await github.graphql(`
        mutation($id: ID!, $body: String!) {
          addComment(input: { subjectId: $id, body: $body }) {
            commentEdge { node { id } }
          }
        }`, { id: subjectNodeId, body });
    }
  }

  // Post a plain comment on an issue or PR (skipping empty bodies and dry-run).
  async function comment(repo, subjectNodeId, body) {
    if (!body) return;
    if (!dryRun) {
      await writeComment(subjectNodeId, null, body);
    }
  }

  // Read a managed repo's optional per-step guidance file (.github/puppets/<step>.md) from
  // its default branch. This is the trusted, repo-owned augmentation to the base prompt.
  // Returns null when absent (404); throws on a present-but-invalid file so the caller can
  // skip that repo rather than guess. Capped at 20 KB.
  async function readStepInstructions(repo, defaultBranch, step) {
    const path = `.github/puppets/${step}.md`;
    try {
      const response = await github.rest.repos.getContent({
        owner, repo, path, ref: defaultBranch,
      });
      if (Array.isArray(response.data) || response.data.type !== 'file') {
        throw new Error(`${path} is not a file`);
      }
      if (response.data.size > 20000) {
        throw new Error(`${path} exceeds the 20 KB instruction limit`);
      }
      return {
        path,
        content: Buffer.from(response.data.content, 'base64').toString('utf8').trim(),
      };
    } catch (error) {
      if (error.status === 404) return null;
      throw new Error(`Could not load ${owner}/${repo}/${path}: ${error.message}`);
    }
  }

  // Post (or update, keyed off `marker`) the trusted instruction comment for a step. The
  // body is the base prompt for that step (from .github/puppets/prompts/<step>.md) followed
  // by the managed repo's optional per-repo guidance, clearly attributed to its source file.
  // Idempotent: the hidden marker lets repeated runs update one comment instead of stacking.
  async function upsertStepInstructions(step, marker, heading, repo, targetNumber, subjectNodeId, defaultBranch, perRepo) {
    const base = prompts[step] || '';
    if (!base && !perRepo?.content) return; // nothing to say for this step
    // Assemble the instruction body, then tuck it inside a collapsed <details> block so it
    // stays out of the way on the issue/PR thread while remaining fully present in the
    // comment text (the Copilot coding agent reads the raw body regardless of collapse).
    const inner = [];
    if (base) inner.push(base);
    if (perRepo?.content) {
      const sourceUrl =
        `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${perRepo.path}`;
      inner.push(
        '',
        '---',
        `Repository-specific guidance (trusted source: [\`${perRepo.path}\` on \`${defaultBranch}\`](${sourceUrl})):`,
        '',
        perRepo.content,
      );
    }
    const body = [
      marker,
      '<details>',
      `<summary>${heading} (click to expand)</summary>`,
      '', // blank line required so GitHub renders the inner Markdown
      ...inner,
      '',
      '</details>',
    ].join('\n');
    console.log(`  ${step} instructions${perRepo?.content ? ` + ${perRepo.path}@${defaultBranch}` : ''}`);
    if (dryRun) return;

    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: targetNumber, per_page: 100,
    });
    const existing = comments.find(candidate =>
      candidate.user?.login?.toLowerCase() === automationLogin &&
      candidate.body?.includes(marker)
    );
    await writeComment(subjectNodeId, existing?.node_id ?? null, body);
  }

  async function latestApprovalEvent(repo, issueNumber) {
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner, repo, issue_number: issueNumber, per_page: 100,
    });
    return events.reverse().find(event =>
      event.event === 'labeled' && event.label?.name === 'puppets:approved'
    );
  }

  async function validApproval(repo, issue) {
    const event = await latestApprovalEvent(repo, issue.number);
    const actor = event?.actor?.login;
    if (!actor || !approvalActors.has(actor.toLowerCase())) {
      return { valid: false, reason: `label was added by ${actor || 'an unknown actor'}` };
    }

    try {
      const response = await github.rest.repos.getCollaboratorPermissionLevel({
        owner, repo, username: actor,
      });
      const permission = response.data.user?.permissions
        ? Object.entries(response.data.user.permissions)
            .filter(([, allowed]) => allowed)
            .map(([name]) => name)
        : [response.data.permission];
      if (!permission.some(level => approvalPermissions.has(level))) {
        return { valid: false, reason: `${actor} lacks write/triage permission` };
      }
    } catch (error) {
      return { valid: false, reason: `could not verify ${actor}: ${error.message}` };
    }

    return { valid: true, actor };
  }

  async function getCopilotBotId(repo) {
    const result = await github.graphql(`
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 25) {
            nodes { login __typename ... on Bot { id } }
          }
        }
      }`, { owner, repo });
    const bot = result.repository.suggestedActors.nodes.find(node =>
      node.login === 'copilot-swe-agent' || node.login.toLowerCase() === 'copilot'
    );
    return bot?.id || null;
  }

  async function assignCopilot(issue, botId) {
    const actorIds = [...(issue.assignees || []).map(assignee => assignee.node_id), botId];
    await github.graphql(`
      mutation($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: {
          assignableId: $assignableId,
          actorIds: $actorIds
        }) {
          assignable {
            ... on Issue { number assignees(first: 10) { nodes { login } } }
          }
        }
      }`, { assignableId: issue.node_id, actorIds: [...new Set(actorIds)] });
  }

  // Find the pull request most relevant to an issue's implementation, looking at
  // both PRs that declare they close it and plain cross-references. Prefers a
  // merged PR, then an open non-draft PR, then any open PR, else the newest.
  async function findLinkedPR(repo, issueNumber) {
    const prFields = `
      number id state isDraft merged mergeable mergeStateStatus headRefName headRefOid
      assignees(first: 10) { nodes { id login } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
    const result = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
              nodes { ${prFields} }
            }
            timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
              nodes {
                ... on CrossReferencedEvent {
                  source { ... on PullRequest { ${prFields} } }
                }
              }
            }
          }
        }
      }`, { owner, repo, number: issueNumber });
    const issue = result.repository.issue;
    const byNumber = new Map();
    for (const pr of issue.closedByPullRequestsReferences.nodes || []) {
      if (pr?.number) byNumber.set(pr.number, pr);
    }
    for (const item of issue.timelineItems.nodes || []) {
      const pr = item?.source;
      if (pr?.number) byNumber.set(pr.number, pr);
    }
    const prs = [...byNumber.values()];
    if (prs.length === 0) return null;
    return prs.find(pr => pr.merged)
      || prs.find(pr => pr.state === 'OPEN' && !pr.isDraft)
      || prs.find(pr => pr.state === 'OPEN')
      || prs.sort((a, b) => b.number - a.number)[0];
  }

  const rollupState = pr => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;

  async function rerunActionRequiredWorkflows(repo, pr) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      owner,
      repo,
      event: 'pull_request',
      head_sha: pr.headRefOid,
      per_page: 100,
    });
    const blocked = runs.filter(run => run.conclusion === 'action_required');
    let rerunCount = 0;
    for (const run of blocked) {
      console.log(`  workflow ${run.name || run.id} action_required -> rerun`);
      if (!dryRun) {
        try {
          await github.rest.actions.reRunWorkflow({
            owner, repo, run_id: run.id,
          });
          rerunCount++;
        } catch (error) {
          if (error.status === 403 && error.message.includes('Resource not accessible by personal access token')) {
            core.warning(
              `Could not rerun ${repo} workflow ${run.id}: the controller PAT needs Actions: write permission.`
            );
          } else {
            throw error;
          }
        }
      } else {
        rerunCount++;
      }
    }
    return rerunCount;
  }

  async function markPrReady(prId) {
    if (dryRun) return;
    await github.graphql(`
      mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { number isDraft }
        }
      }`, { id: prId });
  }

  // Persist the number of Copilot conflict-resolution attempts on the PR via a
  // hidden marker comment, so the count survives across reconciler runs.
  const conflictMarker = '<!-- puppets:conflict:v1 -->';
  async function getConflictAttempts(repo, prNumber) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    const marker = comments.find(c => c.body?.includes(conflictMarker));
    if (!marker) return { attempts: 0, commentNodeId: null };
    const match = marker.body.match(/attempts:\s*(\d+)/);
    return { attempts: match ? Number.parseInt(match[1], 10) : 0, commentNodeId: marker.node_id };
  }
  async function setConflictAttempts(repo, prNodeId, attempts, note, existingCommentNodeId) {
    const body = `${conflictMarker}\n**Puppets — merge conflict** · attempts: ${attempts}/${conflictRetries}\n${note}`;
    if (dryRun) return;
    await writeComment(prNodeId, existingCommentNodeId, body);
  }

  // Re-engage the Copilot coding agent on an existing PR by re-asserting its
  // assignment and (optionally) posting a directive comment on the PR.
  async function repromptCopilot(repo, pr, botId, directive) {
    const actorIds = [...new Set([...(pr.assignees?.nodes || []).map(a => a.id), botId])];
    if (dryRun) return;
    await github.graphql(`
      mutation($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable { ... on PullRequest { number } }
        }
      }`, { assignableId: pr.id, actorIds });
    if (directive) {
      await writeComment(pr.id, null, directive);
    }
  }

  // ── M2 Curation ──────────────────────────────────────────────────────────────

  // Call GitHub Models (OpenAI-compatible) with a system prompt and user message.
  // Returns the raw content string from the first choice.
  // Throws on HTTP or API errors so the caller can handle the failure gracefully.
  async function callModels(systemPrompt, userMessage) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set; cannot call GitHub Models');
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub Models API returned ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  // Run agentic curation on an issue: abuse screen, dedupe, and auto-labeling.
  // Called after the issue has already been moved to `puppets:curating`.
  // On success: transitions the issue to `puppets:ready` or `puppets:needs-human`,
  // or closes it if it is a duplicate.
  // Throws on unrecoverable errors so the caller can roll back to `puppets:approved`.
  async function curateIssue(repo, issue, allIssues, repoLabelNames) {
    if (!prompts.curation) {
      // Curation prompt not deployed — skip analysis and mark ready immediately.
      core.warning(`${repo}#${issue.number}: curation.md not found; marking ready without analysis.`);
      await setState(repo, issue, 'puppets:ready');
      return;
    }

    // Compact list of other open issues for near-duplicate detection (max 40 entries).
    const otherIssues = allIssues
      .filter(i => !i.pull_request && i.number !== issue.number)
      .slice(0, 40)
      .map(i => `#${i.number}: ${String(i.title).replace(/\n/g, ' ').slice(0, 100)}`)
      .join('\n');

    // Offer only labels that already exist in the repo plus the standard type:* set.
    const availableLabels = [...repoLabelNames]
      .filter(l => l.startsWith('type:') || l.startsWith('area:'))
      .sort()
      .join(', ') || 'type:bug, type:feature, type:chore';

    const currentLabels = [...issueLabels(issue)]
      .filter(l => !l.startsWith('puppets:'))
      .join(', ') || '(none)';

    const userMessage = [
      `Repository: ${owner}/${repo}`,
      `Issue #${issue.number}: ${issue.title}`,
      '',
      'Body:',
      (issue.body || '(empty)').slice(0, 2000),
      '',
      `Current labels: ${currentLabels}`,
      `Available labels for tagging: ${availableLabels}`,
      '',
      'Other open issues in this repository (for duplicate detection):',
      otherIssues || '(none)',
    ].join('\n');

    // Call GitHub Models — may throw; caller catches and rolls back to approved.
    const raw = await callModels(prompts.curation, userMessage);

    let verdict;
    try {
      verdict = JSON.parse(raw);
    } catch {
      throw new Error(`Models API returned invalid JSON: ${raw.slice(0, 300)}`);
    }

    const decision = verdict?.decision;
    if (!['ready', 'duplicate', 'needs-human'].includes(decision)) {
      throw new Error(`Unexpected curation decision "${decision}"; expected ready|duplicate|needs-human`);
    }

    // Build and upsert the sticky curation verdict comment.
    const commentLines = [
      curationMarker,
      `**Puppets curation** · verdict: \`${decision}\``,
      '',
    ];
    if (verdict.reason) commentLines.push(`> ${verdict.reason}`, '');
    if (Array.isArray(verdict.labels) && verdict.labels.length) {
      commentLines.push(`- tags: ${verdict.labels.join(', ')}`);
    }
    if (verdict.duplicate_of) {
      commentLines.push(`- duplicate-of: #${verdict.duplicate_of}`);
    }
    if (verdict.for_human) {
      commentLines.push('', '---', `**For the human:** ${verdict.for_human}`);
    }
    const curationComment = commentLines.join('\n');

    if (!dryRun) {
      const comments = await github.paginate(github.rest.issues.listComments, {
        owner, repo, issue_number: issue.number, per_page: 100,
      });
      const existing = comments.find(c =>
        c.user?.login?.toLowerCase() === automationLogin && c.body?.includes(curationMarker)
      );
      if (existing) {
        await github.rest.issues.updateComment({
          owner, repo, comment_id: existing.id, body: curationComment,
        });
      } else {
        await github.rest.issues.createComment({
          owner, repo, issue_number: issue.number, body: curationComment,
        });
      }
    }

    if (decision === 'duplicate') {
      const dupeNum = verdict.duplicate_of;
      if (!dupeNum) {
        // Model said duplicate but gave no issue number — bias toward ready.
        core.warning(`${repo}#${issue.number}: duplicate verdict has no duplicate_of; treating as ready.`);
        await setState(repo, issue, 'puppets:ready');
        return;
      }
      console.log(`#${issue.number}: duplicate of #${dupeNum} → closing`);
      if (!dryRun) {
        await github.rest.issues.update({
          owner, repo, issue_number: issue.number,
          state: 'closed', state_reason: 'not_planned',
        });
      }
      // Issue is now closed; no further label transition needed.

    } else if (decision === 'needs-human') {
      console.log(`#${issue.number}: curation escalated → needs-human`);
      waiting.push({
        repo, number: issue.number,
        title: `${issue.title} (needs-human: curation — ${verdict.reason || 'see comment'})`,
      });
      await setState(repo, issue, 'puppets:needs-human');

    } else {
      // decision === 'ready': apply auto-labels, then mark ready.
      const suggestedLabels = Array.isArray(verdict.labels) ? verdict.labels : [];
      const currentIssueLabels = issueLabels(issue);
      for (const label of suggestedLabels) {
        if (currentIssueLabels.has(label)) continue; // already present
        if (repoLabelNames.has(label)) {
          // Existing label — apply directly.
          await addLabel(repo, issue.number, label);
        } else if (/^area:[a-z0-9][a-z0-9-]*$/.test(label)) {
          // Safe new area:* label — create it, then apply.
          console.log(`  + create area label ${label}`);
          if (!dryRun) {
            await github.rest.issues.createLabel({
              owner, repo, name: label, color: '0075ca',
              description: `Issues in the ${label.slice(5)} area.`,
            });
          }
          await addLabel(repo, issue.number, label);
        }
        // Any other unknown label name is silently skipped for safety.
      }
      await setState(repo, issue, 'puppets:ready');
      console.log(`#${issue.number}: curation passed → ready`);
    }
  }


  // Advance an already-claimed item along claimed -> in-review -> done based on
  // its PR, and keep the PR mergeable for the configured merge policy.
  // Runs over open AND closed issues (a merged PR auto-closes the issue, so `done`
  // must be applied after close). Forward-only for lifecycle labels.
  async function reconcileInFlight(repo, issue, defaultBranch, reviewInstructions, botIdRef) {
    const labels = issueLabels(issue);
    const pr = await findLinkedPR(repo, issue.number);
    if (!pr) return;

    if (pr.merged) {
      if (!labels.has('puppets:done')) {
        console.log(`#${issue.number}: PR #${pr.number} merged -> done`);
      }
      await setLinkedState(repo, issue, pr, 'puppets:done');
      return;
    }
    if (pr.state !== 'OPEN') return; // closed unmerged -> leave for a human

    const rerunCount = await rerunActionRequiredWorkflows(repo, pr);
    if (rerunCount > 0) {
      const currentState = stateLabels.find(label => labels.has(label)) || 'puppets:claimed';
      await setPrState(repo, pr.number, currentState);
      return;
    }

    // 1. Auto Ready-for-Review: if Copilot left the PR in draft but its checks are
    //    green, it is ready for review and the configured merge policy.
    let wasDraft = false;
    if (pr.isDraft) {
      if (rollupState(pr) === 'SUCCESS') {
        console.log(`#${issue.number}: PR #${pr.number} draft + green -> ready for review`);
        await markPrReady(pr.id);
        wasDraft = true; // mergeability was not computed while draft; defer conflict check
      } else {
        const currentState = stateLabels.find(label => labels.has(label)) || 'puppets:claimed';
        await setPrState(repo, pr.number, currentState);
        return; // still a working draft
      }
    }

    // 2. Conflict / staleness handling on a ready PR (skip the run we just un-drafted,
    //    since GitHub computes mergeability asynchronously after ready).
    if (!wasDraft && pr.mergeStateStatus === 'BEHIND') {
      console.log(`#${issue.number}: PR #${pr.number} behind base -> update branch`);
      if (!dryRun) {
        try {
          await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number });
        } catch (error) {
          console.log(`  update-branch failed: ${error.message}`);
        }
      }
    } else if (!wasDraft && pr.mergeable === 'CONFLICTING') {
      const { attempts, commentNodeId } = await getConflictAttempts(repo, pr.number);
      if (attempts >= conflictRetries) {
        console.log(`#${issue.number}: PR #${pr.number} conflict unresolved after ${attempts} -> needs-human`);
        await setLinkedState(repo, issue, pr, 'puppets:needs-human');
        await setConflictAttempts(repo, pr.id, attempts, 'Escalated to a human — automated resolution exhausted.', commentNodeId);
        waiting.push({ repo, number: issue.number, title: `${issue.title} (needs-human: merge conflict on PR #${pr.number})` });
      } else {
        const next = attempts + 1;
        console.log(`#${issue.number}: PR #${pr.number} conflicting -> Copilot remediation ${next}/${conflictRetries}`);
        botIdRef.id ??= await getCopilotBotId(repo);
        if (botIdRef.id) {
          await repromptCopilot(repo, pr, botIdRef.id,
            render(prompts.conflict, { attempt: next, total: conflictRetries }));
        }
        await setConflictAttempts(repo, pr.id, next, 'Asked Copilot to resolve the conflict on its branch.', commentNodeId);
        await setLinkedState(repo, issue, pr, 'puppets:needs-work');
        return;
      }
    }

    // 3. Otherwise it is open and ready -> in-review. On entering review, hand Copilot the
    //    review prompt (base + per-repo review.md) as a trusted comment on the PR so the
    //    review step is itself LLM-driven. The marker keeps this to a single comment.
    if (!labels.has('puppets:needs-human')) {
      if (!labels.has('puppets:in-review')) {
        console.log(`#${issue.number}: PR #${pr.number} ready for review -> in-review`);
        try {
          await upsertStepInstructions(
            'review', reviewMarker, 'Puppets review instructions',
            repo, pr.number, pr.id, defaultBranch, reviewInstructions
          );
        } catch (error) {
          core.warning(`  review instructions failed for ${repo}#${pr.number}: ${error.message}`);
        }
      }
      await setLinkedState(repo, issue, pr, 'puppets:in-review');
    }
  }

  const waiting = [];
  const inbox = [];
  const inboxKeys = new Set(); // tracks `${repo}#${number}` — used to de-dup stale list
  const stale = [];
  let assigned = 0;

  for (const repo of repos) {
    console.log(`\n📦 ${owner}/${repo}`);
    const repository = await github.rest.repos.get({ owner, repo });
    const defaultBranch = repository.data.default_branch;
    // Load this repo's optional per-repo guidance for the two LLM steps up front. A
    // present-but-invalid file (too big / wrong type) skips the whole repo rather than
    // letting the agent run on half-read instructions.
    let implementationInstructions;
    let reviewInstructions;
    try {
      implementationInstructions =
        await readStepInstructions(repo, defaultBranch, 'implementation');
      reviewInstructions =
        await readStepInstructions(repo, defaultBranch, 'review');
    } catch (error) {
      core.error(error.message);
      console.log(`Skipping ${owner}/${repo} because its instructions are invalid.`);
      continue;
    }
    // Fetch existing repo labels once for curation auto-labeling.
    const repoLabelsList = await github.paginate(github.rest.issues.listLabelsForRepo, {
      owner, repo, per_page: 100,
    });
    const repoLabelNames = new Set(repoLabelsList.map(l => l.name));
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'open', sort: 'updated', direction: 'desc', per_page: 100,
    });
    const inFlightByNumber = new Map();
    for (const state of ['puppets:claimed', 'puppets:in-review', 'puppets:needs-work']) {
      const tracked = await github.paginate(github.rest.issues.listForRepo, {
        owner, repo, state: 'all', labels: state, per_page: 100,
      });
      for (const issue of tracked) {
        if (!issue.pull_request) inFlightByNumber.set(issue.number, issue);
      }
    }
    const inFlightCount = inFlightByNumber.size;
    let assignedInRepo = 0;
    let botId;

    for (const issue of issues) {
      if (issue.pull_request || isBotFiled(issue)) continue;
      const labels = issueLabels(issue);

      // New arrival with no puppets:* label yet -> needs your decision (approve or
      // ignore). Announced once, keyed off the inbox cutoff above.
      if (new Date(issue.created_at) > inboxSince &&
          ![...labels].some(label => label.startsWith('puppets:'))) {
        inbox.push({ repo, number: issue.number, title: issue.title });
        inboxKeys.add(`${repo}#${issue.number}`);
      }
      // Stale un-triaged: no puppets:* label, older than staleHours, not in the new-issues
      // inbox (de-duped by key so a brand-new issue never appears in both sections).
      if (![...labels].some(label => label.startsWith('puppets:')) &&
          new Date(issue.created_at) <= staleThreshold &&
          !inboxKeys.has(`${repo}#${issue.number}`)) {
        stale.push({ repo, number: issue.number, title: issue.title });
      }
      if (labels.has('puppets:no-auto')) continue;

      if (labels.has('puppets:approved')) {
        const approval = await validApproval(repo, issue);
        if (!approval.valid) {
          console.log(`#${issue.number}: invalid approval (${approval.reason})`);
          await removeLabel(repo, issue.number, 'puppets:approved', labels);
          await comment(
            repo,
            issue.node_id,
            render(prompts.invalidApproval, { reason: approval.reason })
          );
          continue;
        }

        // M1 parity mode: skip curation and assign Copilot directly.
        if (process.env.ENABLE_CURATION === 'false') {
          if (assignedInRepo >= maxPerRepo) continue;
          if (inFlightCount + assignedInRepo >= maxInFlightPerRepo) {
            console.log(`#${issue.number}: in-flight cap reached (${maxInFlightPerRepo})`);
            continue;
          }
          console.log(`#${issue.number}: approved by ${approval.actor} (curation disabled)`);
          const alreadyAssigned = (issue.assignees || []).some(assignee =>
            ['copilot', 'copilot-swe-agent'].includes(assignee.login.toLowerCase())
          );
          if (!alreadyAssigned) {
            await upsertStepInstructions(
              'implementation', implementationMarker, 'Puppets implementation instructions',
              repo, issue.number, issue.node_id, defaultBranch, implementationInstructions
            );
            if (!dryRun) {
              botId ??= await getCopilotBotId(repo);
              if (!botId) {
                throw new Error(`Copilot coding agent is not assignable in ${owner}/${repo}`);
              }
              await assignCopilot(issue, botId);
            }
          }
          await setState(repo, issue, 'puppets:claimed');
          assignedInRepo++;
          assigned++;
          console.log(`  ${dryRun ? 'would assign' : 'assigned'} Copilot`);
          continue;
        }

        // M2: move to curating, then run curation. On failure, roll back to
        // approved so the item is retried on the next reconciler run.
        console.log(`#${issue.number}: approved by ${approval.actor} → curating`);
        await setState(repo, issue, 'puppets:curating');
        try {
          await curateIssue(repo, issue, issues, repoLabelNames);
        } catch (error) {
          core.warning(`Curation failed for ${repo}#${issue.number}: ${error.message}. Rolling back to approved.`);
          await setState(repo, issue, 'puppets:approved');
        }
        continue;
      }

      // Recovery: an issue left in `curating` from a previous failed run.
      if (labels.has('puppets:curating')) {
        console.log(`#${issue.number}: retrying curation (was stuck in curating)`);
        try {
          await curateIssue(repo, issue, issues, repoLabelNames);
        } catch (error) {
          core.warning(`Curation retry failed for ${repo}#${issue.number}: ${error.message}.`);
          // Leave in curating; will retry on the next run.
        }
        continue;
      }

      // Claim and assign a ready item (result of a successful curation pass).
      if (labels.has('puppets:ready')) {
        if (assignedInRepo >= maxPerRepo) continue;
        if (inFlightCount + assignedInRepo >= maxInFlightPerRepo) {
          console.log(`#${issue.number}: in-flight cap reached (${maxInFlightPerRepo})`);
          continue;
        }
        const alreadyAssigned = (issue.assignees || []).some(assignee =>
          ['copilot', 'copilot-swe-agent'].includes(assignee.login.toLowerCase())
        );
        console.log(`#${issue.number}: ready → claiming`);

        if (!alreadyAssigned) {
          try {
            await upsertStepInstructions(
              'implementation', implementationMarker, 'Puppets implementation instructions',
              repo, issue.number, issue.node_id, defaultBranch, implementationInstructions
            );
          } catch (error) {
            core.warning(`  implementation instructions failed for ${repo}#${issue.number}: ${error.message}`);
          }
          if (!dryRun) {
            botId ??= await getCopilotBotId(repo);
            if (!botId) {
              throw new Error(`Copilot coding agent is not assignable in ${owner}/${repo}`);
            }
            await assignCopilot(issue, botId);
          }
        }

        await setState(repo, issue, 'puppets:claimed');
        assignedInRepo++;
        assigned++;
        console.log(`  ${dryRun ? 'would assign' : 'assigned'} Copilot`);
        continue;
      }

      if (labels.has('puppets:needs-info')) {
        if (hasEnoughDetail(issue)) {
          console.log(`#${issue.number}: sufficient detail added`);
          await removeLabel(repo, issue.number, 'puppets:needs-info', labels);
        }
        continue;
      }

      if (stateLabels.some(label => labels.has(label))) continue;

      if (!hasEnoughDetail(issue)) {
        console.log(`#${issue.number}: needs more information`);
        await setState(repo, issue, 'puppets:needs-info');
        await comment(repo, issue.node_id, prompts.needsInfo);
      }
    }

    // After triage/approval, advance items already handed to Copilot by polling
    // their PR: claimed -> in-review (PR ready) -> done (PR merged), plus keep the
    // PR mergeable (update stale branches, loop Copilot on conflicts). Query open
    // AND closed issues, since a merged PR closes the issue before we mark it done.
    const botIdRef = { id: botId };
    for (const issue of inFlightByNumber.values()) {
      await reconcileInFlight(repo, issue, defaultBranch, reviewInstructions, botIdRef);
    }
  }

  const renderList = items => items.slice(0, 20).map(item =>
    `• [${item.repo}#${item.number}](https://github.com/${owner}/${item.repo}/issues/${item.number}) — ${item.title}`
  ).join('\n');

  const sections = [];
  if (inbox.length) {
    sections.push(`**🆕 New issues to review (${inbox.length})** — approve with \`puppets:approved\` or ignore:\n${renderList(inbox)}`);
  }
  if (stale.length) {
    sections.push(`**🔁 Stale un-triaged issues (${stale.length})** — still needs \`puppets:approved\` or \`puppets:no-auto\`:\n${renderList(stale)}`);
  }
  if (waiting.length) {
    sections.push(`**⏳ Needs a decision (${waiting.length})**:\n${renderList(waiting)}`);
  }
  const attentionCount = inbox.length + stale.length + waiting.length;
  const waitingMessage = sections.length === 0
    ? 'No issues currently need your attention.'
    : sections.join('\n\n');

  core.setOutput('waiting_count', String(attentionCount));
  core.setOutput('waiting_message', waitingMessage);
  await core.summary
    .addHeading('Puppets lifecycle')
    .addRaw(`Assigned: ${assigned}\n\nNeeds your attention: ${attentionCount}\n\n${waitingMessage}`)
    .write();
};
