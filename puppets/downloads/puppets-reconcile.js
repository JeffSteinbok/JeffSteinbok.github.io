module.exports = async ({ github, context, core }) => {
  const owner = process.env.PUPPETS_OWNER.trim();
  const dryRun = process.env.DRY_RUN === 'true';
  const maxPerRepo = Number.parseInt(process.env.MAX_ISSUES_PER_REPO, 10);
  const conflictRetries = Math.max(1, Number.parseInt(process.env.CONFLICT_RETRIES, 10) || 2);
  const repos = process.env.PUPPETS_REPOSITORIES.trim().split('\n').map(r => r.trim()).filter(Boolean);
  const authenticatedUser = await github.rest.users.getAuthenticated();
  const automationLogin = authenticatedUser.data.login.toLowerCase();
  const approvalActors = new Set(
    process.env.PUPPETS_APPROVAL_ACTORS
      .split('\n')
      .map(actor => actor.trim().toLowerCase())
      .filter(Boolean)
  );
  const approvalPermissions = new Set(['admin', 'maintain', 'push', 'write', 'triage']);
  const implementationMarker = '<!-- puppets:implementation-instructions:v1 -->';
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

  if (!Number.isInteger(maxPerRepo) || maxPerRepo < 1) {
    throw new Error('max_issues_per_repo must be a positive integer');
  }
  if (!owner || repos.length === 0 || approvalActors.size === 0) {
    throw new Error('owner, repositories, and approval_actors must not be empty');
  }

  // "Inbox" cutoff: surface issues filed since this workflow's previous run, so a
  // freshly filed issue is announced exactly once and old backlog is never swept.
  // Falls back to a fixed lookback when there is no prior run (e.g. the first run).
  const inboxFallbackHours = Math.max(1, Number.parseInt(process.env.INBOX_FALLBACK_HOURS, 10) || 24);
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

  const labelName = label => typeof label === 'string' ? label : label.name;
  const issueLabels = issue => new Set((issue.labels || []).map(labelName));
  const isBotFiled = issue =>
    issue.user?.type === 'Bot' || issue.user?.login?.toLowerCase().endsWith('[bot]');
  const hasEnoughDetail = issue => (issue.body || '').trim().length >= 40;

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

  async function comment(repo, issueNumber, body) {
    if (!dryRun) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: issueNumber, body,
      });
    }
  }

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

  async function upsertImplementationInstructions(repo, issue, defaultBranch, instructions) {
    if (!instructions?.content) return;
    const sourceUrl =
      `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${instructions.path}`;
    const body = [
      implementationMarker,
      `### Puppets implementation instructions`,
      '',
      `Trusted source: [\`${instructions.path}\` on \`${defaultBranch}\`](${sourceUrl})`,
      '',
      instructions.content,
    ].join('\n');
    console.log(`  implementation instructions: ${instructions.path}@${defaultBranch}`);
    if (dryRun) return;

    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: issue.number, per_page: 100,
    });
    const existing = comments.find(candidate =>
      candidate.user?.login?.toLowerCase() === automationLogin &&
      candidate.body?.includes(implementationMarker)
    );
    if (existing) {
      await github.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body,
      });
    } else {
      await github.rest.issues.createComment({
        owner, repo, issue_number: issue.number, body,
      });
    }
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
      number id state isDraft merged mergeable mergeStateStatus headRefName
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
    if (!marker) return { attempts: 0, commentId: null };
    const match = marker.body.match(/attempts:\s*(\d+)/);
    return { attempts: match ? Number.parseInt(match[1], 10) : 0, commentId: marker.id };
  }
  async function setConflictAttempts(repo, prNumber, attempts, note, existingId) {
    const body = `${conflictMarker}\n**Puppets — merge conflict** · attempts: ${attempts}/${conflictRetries}\n${note}`;
    if (dryRun) return;
    if (existingId) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existingId, body });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
  }

  // Re-engage the Copilot coding agent on an existing PR (remediation loop) by
  // re-asserting its assignment and posting a directive comment on the PR.
  async function repromptCopilot(repo, pr, botId, directive) {
    const actorIds = [...new Set([...(pr.assignees?.nodes || []).map(a => a.id), botId])];
    if (dryRun) return;
    await github.graphql(`
      mutation($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable { ... on PullRequest { number } }
        }
      }`, { assignableId: pr.id, actorIds });
    await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: directive });
  }

  // Advance an already-claimed item along claimed -> in-review -> done based on
  // its PR, and keep the PR mergeable for the configured merge policy.
  // Runs over open AND closed issues (a merged PR auto-closes the issue, so `done`
  // must be applied after close). Forward-only for lifecycle labels.
  async function reconcileInFlight(repo, issue, botIdRef) {
    const labels = issueLabels(issue);
    const pr = await findLinkedPR(repo, issue.number);
    if (!pr) return;

    if (pr.merged) {
      if (!labels.has('puppets:done')) {
        console.log(`#${issue.number}: PR #${pr.number} merged -> done`);
        await setState(repo, issue, 'puppets:done');
      }
      return;
    }
    if (pr.state !== 'OPEN') return; // closed unmerged -> leave for a human

    // 1. Auto Ready-for-Review: if Copilot left the PR in draft but its checks are
    //    green, it is ready for review and the configured merge policy.
    let wasDraft = false;
    if (pr.isDraft) {
      if (rollupState(pr) === 'SUCCESS') {
        console.log(`#${issue.number}: PR #${pr.number} draft + green -> ready for review`);
        await markPrReady(pr.id);
        wasDraft = true; // mergeability was not computed while draft; defer conflict check
      } else {
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
      const { attempts, commentId } = await getConflictAttempts(repo, pr.number);
      if (attempts >= conflictRetries) {
        console.log(`#${issue.number}: PR #${pr.number} conflict unresolved after ${attempts} -> needs-human`);
        await setState(repo, issue, 'puppets:needs-human');
        await setConflictAttempts(repo, pr.number, attempts, 'Escalated to a human — automated resolution exhausted.', commentId);
        waiting.push({ repo, number: issue.number, title: `${issue.title} (needs-human: merge conflict on PR #${pr.number})` });
      } else {
        const next = attempts + 1;
        console.log(`#${issue.number}: PR #${pr.number} conflicting -> Copilot remediation ${next}/${conflictRetries}`);
        botIdRef.id ??= await getCopilotBotId(repo);
        if (botIdRef.id) {
          await repromptCopilot(repo, pr, botIdRef.id,
            '@copilot this PR has merge conflicts with the base branch. ' +
            'Please merge the base branch into this one, resolve every conflict, and push. ' +
            `(Puppets remediation attempt ${next}/${conflictRetries}.)`);
        }
        await setConflictAttempts(repo, pr.number, next, 'Asked Copilot to resolve the conflict on its branch.', commentId);
        await setState(repo, issue, 'puppets:needs-work');
        return;
      }
    }

    // 3. Otherwise it is open and ready -> in-review.
    if (!labels.has('puppets:in-review') && !labels.has('puppets:needs-human')) {
      console.log(`#${issue.number}: PR #${pr.number} ready for review -> in-review`);
      await setState(repo, issue, 'puppets:in-review');
    }
  }

  const waiting = [];
  const inbox = [];
  let assigned = 0;

  for (const repo of repos) {
    console.log(`\n📦 ${owner}/${repo}`);
    const repository = await github.rest.repos.get({ owner, repo });
    const defaultBranch = repository.data.default_branch;
    let implementationInstructions;
    try {
      implementationInstructions =
        await readStepInstructions(repo, defaultBranch, 'implementation');
    } catch (error) {
      core.error(error.message);
      console.log(`Skipping ${owner}/${repo} because its instructions are invalid.`);
      continue;
    }
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'open', sort: 'updated', direction: 'desc', per_page: 100,
    });
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
      }
      if (labels.has('puppets:no-auto')) continue;

      if (labels.has('puppets:approved')) {
        const approval = await validApproval(repo, issue);
        if (!approval.valid) {
          console.log(`#${issue.number}: invalid approval (${approval.reason})`);
          await removeLabel(repo, issue.number, 'puppets:approved', labels);
          await comment(
            repo,
            issue.number,
            `Puppets removed an invalid approval: ${approval.reason}. ` +
              'An allowlisted collaborator with write or triage access must apply `puppets:approved`.'
          );
          continue;
        }

        if (assignedInRepo >= maxPerRepo) continue;
        const alreadyAssigned = (issue.assignees || []).some(assignee =>
          ['copilot', 'copilot-swe-agent'].includes(assignee.login.toLowerCase())
        );
        console.log(`#${issue.number}: approved by ${approval.actor}`);

        if (!alreadyAssigned) {
          await upsertImplementationInstructions(
            repo,
            issue,
            defaultBranch,
            implementationInstructions
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
        await comment(
          repo,
          issue.number,
          'Please add enough detail to reproduce or evaluate this issue (at least a short description, expected behavior, and actual behavior).'
        );
      }
    }

    // After triage/approval, advance items already handed to Copilot by polling
    // their PR: claimed -> in-review (PR ready) -> done (PR merged), plus keep the
    // PR mergeable (update stale branches, loop Copilot on conflicts). Query open
    // AND closed issues, since a merged PR closes the issue before we mark it done.
    const inFlightByNumber = new Map();
    for (const state of ['puppets:claimed', 'puppets:in-review', 'puppets:needs-work']) {
      const tracked = await github.paginate(github.rest.issues.listForRepo, {
        owner, repo, state: 'all', labels: state, per_page: 100,
      });
      for (const issue of tracked) {
        if (!issue.pull_request) inFlightByNumber.set(issue.number, issue);
      }
    }
    const botIdRef = { id: botId };
    for (const issue of inFlightByNumber.values()) {
      await reconcileInFlight(repo, issue, botIdRef);
    }
  }

  const renderList = items => items.slice(0, 20).map(item =>
    `• [${item.repo}#${item.number}](https://github.com/${owner}/${item.repo}/issues/${item.number}) — ${item.title}`
  ).join('\n');

  const sections = [];
  if (inbox.length) {
    sections.push(`**🆕 New issues to review (${inbox.length})** — approve with \`puppets:approved\` or ignore:\n${renderList(inbox)}`);
  }
  if (waiting.length) {
    sections.push(`**⏳ Needs a decision (${waiting.length})**:\n${renderList(waiting)}`);
  }
  const attentionCount = inbox.length + waiting.length;
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
