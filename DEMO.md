# Demo runbook

A click-through of this repository's pipeline for a live audience, in the nine steps from
[SPEC.md](SPEC.md) section 8.3. Each step says what to click and what the audience should see.

> **Everything on GitHub's side is described from GitHub's documentation, not from a run.** The
> repository this runbook was written for did not exist yet, so nothing below has been observed on a
> real remote: not the alerts, not push protection, not the environment approvals, not the Pages
> deployment. [Verification status](#verification-status) lists what was and was not checked. Walk
> the whole runbook once, privately, before you show it to anyone.

Keep two facts straight with the audience:

- **The vulnerabilities are planted.** They are listed under
  [Intentional findings](README.md#intentional-findings) in the README. The routes that contain the
  code flaws are switched off in every deployment this pipeline makes.
- **The deployments are mocked.** The pipeline builds and publishes one real image, and it gates and
  records three deployments of it, but nothing keeps running afterwards. See
  [What "deploy" means here](README.md#what-deploy-means-here).

The steps keep the spec's numbering. Two titles are reworded (steps 6 and 8) because the spec
promises more than a mocked pipeline delivers.

## Before you start

### Plan requirements

Check these before you create the repository, because several features depend on the plan. The table
follows GitHub's documentation at the time of writing. Confirm it against your own plan.

| This demo uses | A private repository needs |
|---|---|
| Rulesets (`main-protection.json`) | A paid plan: Pro, Team or Enterprise Cloud. On Free, rulesets are available for public repositories only |
| A wait timer and required reviewers on environments (`test`, `prod`) | GitHub Enterprise. On Free, Pro and Team these two settings are available for public repositories only. Private repositories on Pro and Team get environments, environment secrets and deployment branch rules |
| Code scanning, secret scanning and push protection | Code Security and Secret Protection (together, formerly GitHub Advanced Security) on Team or Enterprise. Public repositories get them free |
| Artifact attestations (step 9) | GitHub Enterprise Cloud |
| GitHub Pages (step 6) | A paid plan. The published site is public on the internet unless your organization is on Enterprise Cloud and publishes privately |

If your plan falls short, the demo still runs, but the affected steps will not behave as written. This
runbook does not choose for you: decide before you start.

### Accounts and tools

- **A presenter account** with admin access to the repository.
- **An approver.** The ruleset requires one approving review, and GitHub does not let the author of a
  pull request approve it. Use a second account, or use the bypass in setup step 5. The `prod`
  environment also needs a reviewer, who can be the presenter (see setup step 4).
- Git, the GitHub CLI (`gh`) and Docker. Docker is needed only to log in to GHCR for step 9.

### Pre-demo setup

Do this once, in this order. It follows Appendix B of the spec, with one addition: step 7, the synthetic
secret. The spec's last step, walking the runbook once, is step 8.

**1. Create the repository.** Create it as private, as the spec says, subject to the plan table above.

**2. Confirm the security features.** Open Settings → "Security and quality" → "Advanced Security" and
confirm each of these:

- Code Security and Secret Protection are enabled. This is the spec's "GHAS enabled".
- "Push protection" is enabled inside "Secret Protection". Enable Secret Protection first if it is off.
- "Dependency Graph" and "Dependabot alerts" are on. Dependabot alerts are not enabled by default and
  need the dependency graph, and the dependency review check needs the graph too.
- "CodeQL analysis" stays on advanced setup, which is this repository's own `codeql.yml`. Do not switch
  it to default setup: GitHub documents that default setup disables the existing workflow.

The spec calls this area the "Security tab". GitHub currently labels the tab "Security and quality".
GitHub renames things, so look for the nearest equivalent if a label here is missing.

**3. Push `main`.** This is a human step; nothing in this repository pushes for you. The push starts
CI, CodeQL and CD. Two consequences:

- If `dev`, `test` and `prod` do not exist yet when the push lands, the first CD run is not gated by their
  rules. Do steps 4 and 6 before step 3, or treat the first CD run as a rehearsal. Either way it leaves
  the first image digest, which step 8 rolls back to.
- CodeQL's first run on `main` creates the alerts you show in step 2. Let it finish before you present.

**4. Create the three environments.** Open Settings → "Environments" → "New environment", enter the
name, then "Configure environment". Create `dev`, `test` and `prod` with the protections from spec
section 7.5:

| Environment | Protection | Settings |
|---|---|---|
| `dev` | None | None |
| `test` | A 5-minute wait timer. Deployments from `main` only | "Wait timer": 5 minutes (the allowed range is 1 to 43,200). "Deployment branches": "Selected branches and tags", then "Add deployment branch or tag rule" and `main` |
| `prod` | A required reviewer. Deployments from `main` only | "Required reviewers": up to six people, and one approval is enough. "Deployment branches": as for `test` |

- Use exactly these three names. The workflows reference them, and the gate's workflow check rejects any
  other environment name.
- "Prevent self-review" stops the person who triggered a deployment from approving it. If you are the
  only reviewer, leave it off.
- The same page has "Allow administrators to bypass configured protection rules". Decide on it
  deliberately, and confirm in rehearsal that `prod` really pauses.

**5. Apply the ruleset.** Open Settings → "Rulesets" (in the sidebar, under "Code, planning, and
automation") → "New ruleset" ▾ → "Import a ruleset", choose `.github/rulesets/main-protection.json`,
review it, then "Create". You need admin access. The file protects `main` and has no bypass actors.

The spec lists five requirements. The file carries them in four rule objects, because the
`pull_request` rule holds both the approval count and the conversation rule:

| Requirement | In the file |
|---|---|
| A pull request with 1 approval | `pull_request` with `required_approving_review_count: 1` |
| Conversation resolution | `pull_request` with `required_review_thread_resolution: true` |
| Status checks | `required_status_checks`: Install, Gate, Docker build, Dependency review, Analyze (javascript-typescript), Analyze (python) |
| No force pushes | `non_fast_forward` |
| Linear history | `required_linear_history`. Allowed merge methods are squash and rebase, because linear history rules out merge commits |

Other choices in the file: enforcement is `active` (GitHub documents its `evaluate` mode, which only
reports what a rule would have blocked, as an Enterprise feature); a new push dismisses an approval that
was already given; code owner review is not required, so any second collaborator can approve; and the
"up to date" requirement is off, so a pull request does not have to be rebased onto the latest `main`
before it merges.

Check these after you import it:

- **Check names.** A required check is matched by its job name. The two CodeQL names come from the
  matrix in `codeql.yml`, and GitHub does not document how a matrix expands into names, so after the
  first runs compare the pull request's checks list with the ruleset and correct the ruleset if they
  differ. "Dependency review" only runs on pull requests, so it first appears on the first one.
- **Whether GitHub accepts the file.** It has not been imported anywhere. GitHub does not document how
  an empty `bypass_actors` or an empty `exclude` list is handled. If the import refuses the file, delete
  the empty property and set the same thing in the form.
- **Working alone.** With no second approver the merge box stays blocked. Open the ruleset, find the
  "Bypass list", choose "Add bypass" and add yourself. The "For pull requests only" mode limits the
  bypass to pull requests. The alternative is a second collaborator who can approve.
- **Plan.** Rulesets on a private repository need a paid plan, as the table at the top says.

**6. Enable Pages.** Open Settings → "Pages" → "Build and deployment" → "Source" and choose "GitHub
Actions". The other option, "Deploy from a branch", is not what this repository uses. Remember that the
site is public (see the plan table).

**7. Prepare the synthetic secret for step 3.** The spec asks for an obviously fake value that you type
during the demo. It must never be committed, so this runbook does not contain one. It also cannot
promise that any particular fake string is blocked, for this reason: push protection only blocks values
that match a supported token format or a custom pattern. GitHub says it supports only the most recent
token versions it can identify with confidence, and it does not cover passwords or generic AI-detected
secrets. An arbitrary fake can go straight through, which would defeat the demo and put the string in
your history.

The documented route that you control is a custom pattern:

1. Make sure Secret Protection is enabled (setup step 2).
2. Open Settings → "Security and quality" → "Advanced Security". Under "Secret Protection", next to
   "Custom patterns", click "New pattern".
3. Enter a "Pattern name" and a "Secret format", which is a regular expression. Invent a format that no
   real provider uses and that nobody could mistake for a real credential. "More options" lets you add
   surrounding content. Provide a sample test string.
4. Click "Save and dry run". A dry run finds matches without creating alerts and shows up to 1000
   results. Check that your sample matches.
5. Click "Publish pattern". Publishing scans the whole Git history on all branches, so confirm first that
   nothing in the repository matches.
6. Enable push protection for the pattern with "Enable". It is unavailable until the dry run has
   succeeded and the pattern is published, and it only applies to repositories that have push protection
   on.
7. Keep the pattern and a matching value in a private note outside the repository.

An alternative is a test credential that a provider documents itself, if its pattern is listed with
push protection support in GitHub's table of supported secret scanning patterns. GitHub does not publish
a list of test values that are guaranteed to be blocked, and this runbook does not name one. Rehearse
whichever you choose, because the terminal behavior has not been observed here.

**8. Rehearse once, end to end.** Run steps 1 to 9 on the real repository before you show it to anyone.
This also gives you a finished CD run to look at in step 7 and an earlier image digest for step 8.

### Just before you present

- A branch with a one-line documentation change is pushed and ready to open as a pull request.
- CodeQL has finished on `main`, and the alerts are listed.
- Your private note is open with the synthetic value. A terminal is open in a clone of the repository,
  with a clean `git status`.
- You have copied an earlier digest from a previous CD run's "Image built once" summary. It is
  `sha256:` followed by 64 hex digits.
- Your approver is signed in and reachable, or your bypass is in place.
- You have run `docker login ghcr.io`, so step 9's verification works.

## The demo

### 1. Open a pull request: CI, CodeQL and dependency review run in parallel

**Do**

1. Open a pull request from the prepared branch ("Compare & pull request", or Pull requests → "New pull
   request").
2. Scroll to the checks at the bottom of the conversation, or open the "Checks" tab.
3. Open "Details" on the "Gate" job.

**The audience sees**

- A description pre-filled from `.github/pull_request_template.md`, with a checklist that names
  `npm run gate`.
- Four workflows start together. CI has the jobs "Install", "Gate" and "Docker build", which run one
  after another. CodeQL has "Analyze (javascript-typescript)" and "Analyze (python)". Dependency review
  has "Dependency review". Container scan has "Trivy image scan".
- In the "Gate" log, the same `npm run gate` command a contributor runs on a laptop, followed by
  `npm run gate:test`.
- A merge box that stays blocked until the ruleset is satisfied: one approval, the required checks and
  resolved conversations.

**Notes**

- The Trivy scan uploads its results to code scanning and does not fail the run. It is not a required
  check, so it is not in the ruleset.
- Dependency review looks only at the dependency changes in a pull request, and it fails only on high or
  critical advisories. A documentation-only change leaves it nothing to report. The planted `morgan` and
  `requests` advisories are medium and already on `main`, so they will not fail it. To give it
  something to show, include a small dependency change.
- A new push to the pull request dismisses an approval that was already given.

### 2. Open a CodeQL alert: use Copilot Autofix and accept the patch

**Do**

1. Open the repository's "Security and quality" tab (use the "…" dropdown if the tab is hidden), then
   "Code scanning" in the sidebar.
2. Open the alert titled "Uncontrolled command line" (`js/command-line-injection`) in
   `src/insecure-demo.ts`. Open its code flow.
3. Click "Generate fix". When the suggested patch appears, read it aloud, then click "Create PR with
   fix". GitHub opens a draft pull request from a new branch.

**The audience sees**

- The alert with its rule, its location and the path from the request's `text` query parameter to the
  `exec` call.
- A suggested patch, then a draft pull request that contains it.

**Notes**

- The planted alerts live on `main`. A pull request's code scanning results cover the changes it makes,
  and your documentation change does not touch the planted code. That is why you go to the code
  scanning list.
- GitHub documents that Autofix needs no Copilot subscription. It covers a subset of CodeQL queries, and
  whether it covers these two alerts has not been checked. **If Autofix offers no fix,** stay on the code
  flow and describe the fix yourself: replace the shell call with `execFile` and an argument array, so
  no shell parses the input.
- The second planted alert, "Inefficient regular expression" (`js/redos`), points at the pattern in the
  same file. Its fix is a pattern without nested quantifiers plus a length limit.
- **Do not merge the fix pull request.** It removes the planted finding, and then the README's table is
  no longer true. Close it without merging after the demo.
- The alert list will show other alerts too. See [What else you may see](#what-else-you-may-see).

### 3. Attempt to push the synthetic secret: push protection blocks it at the terminal

**Do**

1. In your terminal, make a throwaway branch and commit the value from your private note in a new file:

   ```sh
   git switch -c demo/push-protection
   # paste the value from your private note into a new file, for example demo-note.txt
   git add demo-note.txt
   git commit -m "chore: demo"
   git push -u origin demo/push-protection
   ```

2. Read the terminal output to the audience.
3. Clean up: `git switch main`, then `git branch -D demo/push-protection`.

**The audience sees**

- The push is rejected at the terminal, so the branch does not appear on GitHub. GitHub documents that
  the output says a secret was found and gives two choices: remove the secret, or follow a URL. The
  exact wording has not been observed.

**Notes**

- It blocks only if the value matches a supported pattern or your custom pattern (setup step 7). If the
  push goes through, delete the remote branch, resolve the secret scanning alert it created, and fix the
  pattern before you try again.
- The URL leads to the bypass choices: "It's used in tests", "It's a false positive" or "I'll fix it
  later", and then "Allow me to push this secret", after which you can push again within three hours.
  Someone without bypass rights can choose "Or request bypass privileges" and "Submit request". **Show
  these, but do not use them.** A bypass creates an alert, adds an audit log event and emails the
  owners and admins who watch the repository.
- To fix a blocked push for real, remove the value. If it is in the latest commit, run
  `git commit --amend --all` and push again. If it is in an earlier commit, run `git rebase -i <commit>~1`,
  change that commit's `pick` to `edit`, remove the value, run `git commit --amend`, then
  `git rebase --continue` and push. In this demo the commit exists only to carry the value, so you delete
  the branch instead (the cleanup above).
- A real secret that reached anyone must also be revoked. Removing it from history is not enough.

### 4. Dependabot: alerts, and a pull request with its changelog and compatibility score

**Do**

1. Open Insights → "Dependency graph" → "Dependabot" and look at "Recent update jobs". If nothing has
   run lately, click "Check for updates".
2. Open a Dependabot pull request if one exists. Show the release notes and changelog entries in its
   description, and the compatibility score if it has one.
3. Open the Dependabot alerts under "Security and quality", and show the alerts for `morgan` and
   `requests`.

**The audience sees**

- Dependabot working without being asked: it runs on a weekly schedule, and the pull request carries
  release notes, changelog entries and commit details.
- Alerts for the two planted dependencies, whose advisories are listed in the README.

**Notes**

- **`morgan` and `requests` get no Dependabot pull request, on purpose.** `.github/dependabot.yml`
  ignores both, which suppresses their version-update and security-update pull requests so that the
  findings stay in place. Their alerts are not affected. Any pull request you show comes from the
  other updates: the npm, Docker and GitHub Actions groups. Whether one is open that week is not
  guaranteed, so check beforehand. If none is open, click "Check for updates" and show the alerts instead.
- GitHub documents compatibility scores for Dependabot security updates ("may include compatibility
  scores"), so do not promise one on a version-update pull request.

### 5. Merge: CD builds once, pushes to GHCR, deploys dev then test

**Do**

1. Get the pull request from step 1 approved, with its required checks passing.
2. Click the merge button and choose "Squash and merge" or "Rebase and merge". The ruleset allows
   only those two.
3. Open Actions → "CD" and open the run that the merge started.
4. Open the "Build and publish the image" job's summary.

**The audience sees**

- The CD workflow starts on the push to `main`: first "Build and publish the image", then "Deploy to dev",
  then "Deploy to test".
- The run summary, with an "Image built once" section that gives the image name and the digest, and
  the sentence "dev, test and prod each deploy this digest. None of them builds."
- "Deploy to test" waiting for the 5-minute timer.

**Notes**

- The image is published to GitHub Container Registry as `ghcr.io/<owner>/<repo>` (all lower case),
  tagged with the commit SHA. The build job also generates an SBOM and attests the build provenance.
- This is the only place the image is built. Each deploy job runs `scripts/deploy.mjs` against the
  digest, and the script refuses anything that is not pinned by digest.
- The 5-minute wait is the longest idle stretch. See [Timing](#timing).

### 6. Prod pauses for approval: approve live, and the Pages site is published

**Do**

1. When "Deploy to test" finishes, "Deploy to prod" shows as waiting. In the run, click "Review
   deployments" (it is also in the notification), select `prod`, and click "Approve and deploy". The
   other choice is "Reject".
2. Watch "Deploy to prod" run. Open its summary and follow the "Site:" link.

**The audience sees**

- The run stopped at a human decision, then continuing when the reviewer approves.
- The job summary: "prod is running" with the same digest, and a "Site:" line with the Pages URL.
- A static "Widget Showcase" page.

**Notes**

- The Pages deployment publishes the contents of `public/` only. The page's requests to `/api/version`
  and `/api/widgets` have no service to answer them on that origin, so do not click around and do not
  call it the application. The mocked deploy has already finished and nothing is serving the API.
- The comments in `cd.yml` say the Pages deployment is recorded against `prod`. Whether GitHub reports
  the Pages URL under `prod`, and how the page looks without its API, have not been observed. If the
  "Site:" link is missing or the page misbehaves, say what it is (a static page) and move on.
- The spec's wording is "Pages URL goes green". The thing that goes green is the "Deploy to prod" job.

### 7. Environments: full history, one digest across all three

**Do**

1. On the repository home page, click "Deployments" in the right-hand sidebar. In the left sidebar, click
   "Environments", then click an environment.
2. Show the history, then open the three deploy jobs' summaries, or the three `deploy-record-<env>`
   artifacts on the run page, to compare digests.

**The audience sees**

- Each environment's active deployment and full history, with the associated commits and a "View logs"
  link to the workflow run. Administrators can pin up to ten environments.
- "dev is running", "test is running" and "prod is running" with the same digest.

**Notes**

- GitHub's documentation does not say the Deployments page shows the digest, so show the digest from
  the job summaries or the artifacts. Each artifact holds one `.deploy/<env>.json` record with its
  `env`, `environment`, `image`, `digest`, `timestamp` and `outcome` keys.

### 8. Run `rollback.yml`: the previous digest goes back to prod

**Do**

1. Open Actions → "Rollback" → "Run workflow".
2. Set `environment` to `prod`. Paste the earlier digest into `digest`. Click "Run workflow".
3. Approve the "Roll back prod" job as in step 6.
4. Open the job's summary, and the `rollback-record-prod` artifact.

**The audience sees**

- "Check the digest" passes first. It catches a mistyped digest before anyone is asked to approve.
- "Roll back prod" waits for the prod reviewer, then runs.
- A summary that says "prod is running" followed by the image reference, which ends in the older digest.

**Notes**

- Get the earlier digest from the "Image built once" summary of an earlier CD run. You need two CD runs to
  have two digests: the rehearsal run and the demo run.
- It is the same mocked deployment as CD, for an image that already exists in GHCR. It builds nothing,
  runs no smoke test and publishes no Pages site, which should make it shorter than a CD run. It still
  waits for the prod reviewer, and no timing has been measured. Do not promise "in seconds".

### 9. Close on the Security overview, the SBOM and the build attestation

**Do**

1. **Security overview.** Open your organization's "Security and quality" tab, then "Overview" in the
   sidebar.
2. **SBOM.** In the repository, open Insights → "Dependency graph" → "Dependencies" and click "Export
   SBOM" at the top right. Then open the CD run and show the `sbom.spdx.json` artifact.
3. **Attestation.** Open Actions → "Attestations" (under "Management" in the sidebar). Then, in a
   terminal:

   ```sh
   docker login ghcr.io
   gh attestation verify oci://ghcr.io/<owner>/<repo>:<commit-sha> -R <owner>/<repo>
   ```

**The audience sees**

- An organization-wide view of alerts, a software bill of materials, and a signed statement of where the
  image came from, with the command that checks it.

**Notes**

- Security overview is an organization-level dashboard. What it shows depends on your plan, and it was not
  checked against this repository. If it is thin, close on the repository's own "Security and quality"
  tab instead.
- The dependency graph export is an SPDX document for the repository. The CD artifact is the SBOM of the
  image itself.
- The `oci://` prefix is required. The tag is the commit SHA that built the image, and the image name is
  lower case. The attestations page and the artifact attestations need Enterprise Cloud in a private
  repository.

## Timing

The spec asks for about ten minutes. That figure has not been measured. Two waits are outside your
control: the CD run (an image build, an SBOM and an attestation), and the test environment's 5-minute
wait timer.

Steps 3 and 4 do not depend on CD. If you need to fill the wait, do the merge in step 5 first, present
steps 3 and 4 while the run goes through dev and waits for test, and then continue at step 6. The
numbering is the spec's, and the order is yours.

## After the demo

- Close the Autofix pull request without merging it, unless you mean to retire the planted finding.
- Delete the throwaway branch (locally, and on the remote if a push went through), and delete your
  private note.
- If you used a push-protection bypass, resolve the alert it created.
- Nothing is left running. Each mocked deployment ended with its job.

## What else you may see

The README's table lists what was planted. The alert list can show more, so do not read it as a count of
planted items:

- **`js/missing-rate-limiting` ("Missing rate limiting")** on the route that runs the shell command. It
  is a by-product of the planted code. Rate limiting is out of scope for this service.
- **`js/bad-tag-filter` ("Bad HTML filtering regexp")** in a test file, `test/ui.qa.test.ts`. It is not
  planted, and it was found when the local CodeQL run covered the whole repository.
- **Container scan results.** Trivy uploads its findings to the same code scanning page, so findings
  about `morgan` and about the base image can appear there. Trivy was not run while writing this.

## Verification status

Checked on a developer machine, with no GitHub remote:

- `npm run gate` and `npm run gate:test` pass.
- With `ENABLE_INSECURE_DEMO=true` the `/demo` routes respond. Unset, or set to anything other than
  exactly `true`, they return `404 {"error":"not_found"}`. This was checked with harmless inputs only.
- The CodeQL CLI (2.27.2) with the `security-extended` suite reports `js/command-line-injection` and
  `js/redos` in `src/insecure-demo.ts`, plus the two extra alerts above.
- The ruleset, the issue forms and CODEOWNERS were checked against GitHub's documented structure by a
  local script. GitHub itself has not seen them.

**Not observed. Rehearse every one of these:**

- Any alert on a real remote, and whether Copilot Autofix offers a fix for these two.
- Push protection at the terminal: whether your value is blocked, and the wording of the message.
- Environment approvals, the 5-minute wait, and the pause in `prod`.
- Whether GitHub accepts the ruleset as written, how it treats the empty lists, and the names of the two
  CodeQL checks.
- The Pages deployment: the `prod` environment, the "Site:" URL and the page without its API.
- Whether an open Dependabot pull request exists and whether it shows a compatibility score.
- That the issue forms' `bug` and `enhancement` labels exist in the new repository, because GitHub does
  not add a label that does not exist.
- Anything that runs the container image: the Docker-based steps were not exercised.
- How the README's architecture diagram renders.
- The ten-minute timing.
