# SPEC — GitHub CI/CD & Security Showcase Repository

**Status:** normative. **Repo root:** `C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo`
**Target remote (not created yet):** `ms-mfg-community/github-pipeline-showcase` (private)
**Version:** 1.0 · 2026-10-15

---

## §0. What this is, and how to read it

This repository is a **demonstration asset**. Its purpose is to show the GitHub platform — CI, gated multi-environment CD, Dependabot, CodeQL code scanning, secret scanning, supply-chain attestation — to a **customer-facing** audience.

It is built in four **work packages (WP1–WP4)**. Each is implemented by a separate `dev-qa-judge` run. Appendix A holds the paste-ready invocations.

### How to read this document

| If you are | Read |
|---|---|
| The **dev** stage | §1–§4, then **only** your own WP section. Ignore other WP sections entirely. |
| The **qa** or **judge** stage | §1–§4, then **only** the WP section under review. §3 is binding on your verdict. |
| A human | All of it. |

> **§1–§4 are binding on every work package and on every review verdict.** §3 in particular limits what may be called blocking. A reviewer that raises a finding §3 forbids has made an error, not a catch.

### Non-negotiable context

- **This demo is customer-facing.** No internal URLs, no real tenant/subscription/account IDs, no customer names — in files *or* in git history.
- **The repository contains deliberate, clearly-labelled vulnerabilities and outdated dependencies.** They are required product, not defects. See §3.4.
- **No work package takes any GitHub-side write action.** No pushing, no PRs, no issues, no releases. Local commits only. The remote does not exist yet and creating it is a human step outside this spec.

---

## §1. Global invariants

Binding on all four work packages.

### §1.1 Stack — fixed, do not substitute

| Concern | Choice | Notes |
|---|---|---|
| API runtime | Node.js 24 LTS, TypeScript, ESM | `"type": "module"` |
| Web framework | Express 5 | |
| Test runner | Vitest + Supertest | |
| Lint | ESLint 9 flat config (`eslint.config.js`) | |
| Typecheck | `tsc --noEmit`, `strict: true` | |
| Second language | Python 3.13 | tiny by design — see §1.3 |
| Python lint/test | Ruff + pytest | |
| Container | Docker, multi-stage, non-root | |

Adding any other framework, ORM, database, bundler, or runtime is **out of scope** (§4.2).

### §1.2 Repository layout

Paths marked **(normative)** must exist with exactly that path and name. Anything not listed is at the implementer's discretion.

```
/
  SPEC.md                             (normative — this file; never edit it)
  README.md                           (normative — WP4)
  DEMO.md                             (normative — WP4)
  SECURITY.md                         (normative — WP4)
  CONTRIBUTING.md                     (normative — WP4)
  CODEOWNERS                          (normative — WP4)
  LICENSE                             (normative — WP1, MIT)
  .gitignore                          PRE-BUILT
  .dockerignore                       (normative — WP1)
  package.json                        PRE-BUILT — WP1 adds app deps only (see §2.4)
  tsconfig.json                       PRE-BUILT — do not modify
  eslint.config.js                    PRE-BUILT — do not modify
  vitest.config.ts                    PRE-BUILT — do not modify
  Dockerfile                          (normative — WP1)

  src/
    server.ts                         (normative — WP1) HTTP wiring + listen
    app.ts                            (normative — WP1) exported Express app, no listen
    widgets.ts                        (normative — WP1) in-memory store + domain rules
    config.ts                         (normative — WP1) env parsing
    insecure-demo.ts                  (normative — WP4) DELIBERATE vulnerabilities
  public/
    index.html                        (normative — WP1) static UI
  test/
    *.test.ts                         (at least one; organisation is free)
  tools/
    report.py                         PRE-BUILT — WP1 may extend, must keep it small
    test_report.py                    PRE-BUILT — WP1 may extend
    requirements.txt                  (normative — WP1) runtime pins
    requirements-dev.txt              PRE-BUILT — ruff + pytest, pinned
  scripts/
    gate.mjs                          PRE-BUILT — THE acceptance gate. DO NOT MODIFY.
    setup.mjs                         PRE-BUILT — DO NOT MODIFY.
    gate.test.mjs                     PRE-BUILT — the gate's own tests. DO NOT MODIFY.
    validate-workflows.mjs            (normative — WP2)
    deploy.mjs                        (normative — WP3)
    smoke.mjs                         (normative — WP3)
  .github/
    dependabot.yml                    (normative — WP2)
    workflows/
      ci.yml                          (normative — WP2)
      codeql.yml                      (normative — WP2)
      dependency-review.yml           (normative — WP2)
      scorecard.yml                   (normative — WP2)
      container-scan.yml              (normative — WP2)
      cd.yml                          (normative — WP3)
      rollback.yml                    (normative — WP3)
    ISSUE_TEMPLATE/                   (normative — WP4)
    pull_request_template.md          (normative — WP4)
    rulesets/
      main-protection.json            (normative — WP4)
```

### §1.3 Why Python exists here

`tools/report.py` is deliberately trivial — it reads a JSON deployment record and prints a summary. It exists so the demo can show **two CodeQL languages** and **two Dependabot ecosystems**. It ships **pre-built** with passing tests (§2.4). Do not grow it. A reviewer must not fault it for being small (§3.3).

### §1.4 Commit discipline

Conventional-commit subjects (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`). Commit locally as you go. Never `git push`, never force-push, never rewrite history that already exists.

---

## §2. THE GATE — the single definition of "it works"

**This section is the acceptance criterion for every work package.** Dev runs it before reporting. QA and judge run it themselves rather than trusting any claim.

### §2.1 The two commands

```bash
# from the repository root
npm run setup     # installs Node deps and Python dev deps. Idempotent. Run once per machine.
npm run gate      # the complete gate. Exit 0 = pass. Exit non-zero = fail.
```

**There is no other acceptance criterion.** Do not invent one. If `npm run gate` exits 0 and the WP's named files exist with their specified content, the work package passes.

### §2.2 What `scripts/gate.mjs` does

**It is already written and verified — see §2.4.** This section documents its behaviour so reviewers know what they are reading, not work to be done.

It runs these legs **in order**, continuing through failures so one invocation reports the whole picture, then exits `1` if any leg failed and `0` otherwise.

| # | Leg | Command | Goes live when |
|---|---|---|---|
| 1 | Lint | `eslint .` | live now |
| 2 | Typecheck | `tsc --noEmit` | WP1 creates `src/app.ts` |
| 3 | Unit tests | `vitest run` | WP1 creates `src/app.ts` |
| 4 | Python lint | `ruff check tools` | live now |
| 5 | Python tests | `python -m pytest tools -q` | live now |
| 6 | Workflow validation | `node scripts/validate-workflows.mjs` | WP2 creates the script |
| 7 | Deploy-script self-test | `node scripts/deploy.mjs --self-test` | WP3 creates the script |

Each leg has an **artifact** whose presence decides whether it runs. `lint`, `py-lint` and `py-test` key off files that already exist, so those three are live and green today. `typecheck` and `test` key off **`src/app.ts`** — WP1's own central deliverable — because `tsc` fails outright with no inputs and `vitest` fails with no test files. Legs 6 and 7 key off the scripts WP2 and WP3 create.

This has a consequence worth knowing: **once `src/app.ts` exists, the `test` leg is live.** An application shipped with no tests at all fails the gate rather than passing it quietly.

Output format, one line per leg, then a summary:

```
[gate] lint .................. PASS (1.2s)
[gate] typecheck ............. PASS (2.4s)
[gate] test .................. FAIL (3.1s)
         <the failing leg's own output, indented>
         (exit code 1)
...
[gate] 4/5 leg(s) passed, 2 skipped — FAILED
```

A failing leg prints its own stdout and stderr; a passing one stays quiet. That is deliberate — a red gate must carry enough for the next stage to act without re-running anything.

**A leg whose artifact does not exist is SKIPPED, not failed.** This is what lets WP1 pass before WP2 and WP3 exist. **A leg whose artifact exists but whose tool is not installed FAILS**, with the remedy named — silently skipping it would report a green gate that proved nothing.

**Docker is not a gate leg.** Docker may be unavailable in a given environment, and a gate that depends on it is not reproducible. The container is validated by WP1's acceptance checklist manually, not by the gate.

### §2.3 Running the gate is mandatory for reviewers

A QA or judge verdict based on reading code without running `npm run gate` is incomplete. If the gate cannot be run, say so explicitly in the report rather than inferring a result.

### §2.4 The gate harness is PRE-BUILT and VERIFIED — do not rebuild or modify it

The gate and its toolchain were authored and proven working **before** WP1 began, so that no work package has to invent them and no two work packages can disagree about what "passing" means.

**Pre-built, already in the repository, and off-limits:**

```
scripts/gate.mjs          scripts/setup.mjs          scripts/gate.test.mjs
eslint.config.js          tsconfig.json              vitest.config.ts
tools/requirements-dev.txt
package.json  — the "scripts" block and the existing "devDependencies" pins
```

**Modifying any of these is S1 (§3.1.9).** If you believe the gate is wrong, report it as a finding — do not edit around it. A work package that changes its own acceptance criterion has not met it.

**What WP1 may do to `package.json`:** add application `dependencies` (Express, etc.) and any *additional* devDependencies it needs. It must not remove or re-pin the existing toolchain versions, and must not change the `scripts` block.

**Verified state at handover** — `npm run setup` then `npm run gate`:

```
[gate] lint .................. PASS      [gate] py-test ............... PASS
[gate] typecheck ............. SKIP      [gate] workflows ............. SKIP (WP2)
[gate] test .................. SKIP      [gate] deploy ................ SKIP (WP3)
[gate] py-lint ............... PASS
[gate] 3/3 leg(s) passed, 4 skipped — PASSED          exit code 0
```

`npm run gate:test` runs the gate's own 26-test suite, which covers the skip/fail/pass decision and drives the real gate against throwaway repositories. It passes. WP2 should wire it into `ci.yml`.

**The baseline is green and the repository is clean.** There is no scaffolding to remove and nothing to tidy up before you start. If the gate is red after your change, your change caused it.

#### Known toolchain facts, so you do not rediscover them

- Relative imports **must carry the `.js` extension** (`import { x } from "./widgets.js"`). `moduleResolution` is `NodeNext`; extensionless imports fail typecheck.
- The gate invokes `eslint`, `tsc` and `vitest` through their JavaScript entry points, and Python through the project `.venv`. It does **not** go through `npm run` or `node_modules/.bin`, so changing a `scripts` entry changes nothing the gate measures.
- `vitest` collects `test/**/*.test.ts` and `src/**/*.test.ts` only. A test placed elsewhere will not run.
- `src/` and `test/` do not exist yet — git does not track empty directories. Create them.
- Python dev tools live in a project-local `.venv` created by `npm run setup`. The host interpreter is never modified.
- `tsconfig.json` sets `noUncheckedIndexedAccess`, so indexing an array or record yields `T | undefined`. Handle it; do not disable the flag.

---

## §3. Severity rubric — what may and may not block

**Binding on QA and judge.** The loop requires any non-pass verdict to name at least one S1 or S2 finding. That requirement must never be satisfied by manufacturing one. **If nothing in §3.1 or §3.2 is true, the correct verdict is PASS**, even if the code could be nicer.

### §3.1 S1 — blocking. Only these.

1. `npm run gate` exits non-zero on a clean checkout after `npm run setup`.
2. A file marked **(normative)** for *this work package* in §1.2 is missing.
3. An HTTP response differs from the contract in §5.3 — wrong status code, missing field, or wrong field type.
4. `node scripts/validate-workflows.mjs` reports a violation (WP2 onward).
5. A real credential, token, or private key is committed. *(The synthetic demo secret in WP4 is not a real credential.)*
6. The work changed a file outside the work package's declared scope allowlist.
7. A planted demo finding specified in WP4 is absent or does not contain the pattern it is meant to trigger.
8. An item on **this work package's own acceptance checklist** (§5.7, §6.4, §7.6 or §8.5) is unmet.
9. A pre-built gate-harness file listed in §2.4 was modified.

Rules 1–9 are the complete set of blocking conditions. Nothing else is S1.

### §3.2 S2 — should-fix. Does not block if the dev declines with a stated reason.

1. A behaviour this spec names has no test covering it.
2. Code and its documentation contradict each other.
3. A workflow parses and validates but omits a trigger, permission, or job this spec names for it.
4. An error path specified in §5.3 is unhandled.

### §3.3 S3 — nit. **Never blocks. Never justifies a non-pass verdict.**

Naming · formatting · file organisation beyond §1.2 · comment style or density · test file layout · "could be more idiomatic" · preferring a different library that does the same job · prose wording in README/DEMO · log message phrasing · the absence of anything this spec does not name.

### §3.4 NOT findings at any severity — do not raise these

1. **The deliberate vulnerabilities in `src/insecure-demo.ts`.** They are required demo content (WP4). Reporting them as defects is a misread of the spec.
2. **The deliberately outdated dependencies** in `package.json` and `tools/requirements.txt`. Required, so Dependabot has something to find.
3. **The synthetic secret in `DEMO.md`'s instructions.** It is a fake value used to demo push protection and is never committed as a live credential.
4. **That the GitHub Actions workflows were never executed.** This loop takes no GitHub action by design. Static validation (§2.2 leg 6) *is* the acceptance for workflow files. "Unproven in CI" is not a finding.
5. **That deployments are mocked.** Mocked deployment is the specified design (§7), not a shortfall.
6. **Absence of a feature this spec does not request** — auth, database, rate limiting, observability, i18n, etc. See §4.2.
7. **Test coverage percentage.** No threshold is specified, so none can be failed.
8. **Lint rules disabled inline inside `src/insecure-demo.ts`.** Expected and required there.

### §3.5 Finding format

Every finding needs a `file:line` location and a reproduction another person can run — ideally the gate leg that fails, or a `curl` command and the response it actually produced versus the one §5.3 specifies. A finding with no reproduction is S3 by definition.

---

## §4. Freedom and limits

### §4.1 Explicitly free — the implementer decides, reviewers must not fault

- Internal structure of any module beyond the file paths in §1.2
- How tests are split across files inside `test/`
- Variable, function, and type names
- Error message wording (the `error` *code* values in §5.3 are fixed; human-readable text is free)
- Logging format and library
- README and DEMO prose style, as long as it is customer-appropriate
- Comment quantity
- Which specific vulnerable package version is pinned, provided a real published advisory exists for it

### §4.2 Out of scope — do not build, and do not fault its absence

Authentication or authorisation · any database or persistence beyond in-memory · real cloud provider deployment · message queues · caching layers · rate limiting · metrics/tracing/APM · i18n · a frontend framework (the UI is one static HTML file) · multi-tenancy · any GitHub-side write action · modifying `SPEC.md`.

### §4.3 Scope allowlists

Each WP declares the paths it may touch. Writing outside that list is S1 (§3.1.6). Reading anything is always fine.

---

## §5. WP1 — Application, tests, and container

**Scope allowlist:** `package.json` (add dependencies only — see §2.4), `package-lock.json`, `Dockerfile`, `.dockerignore`, `LICENSE`, `README.md` (stub only), `src/**`, `public/**`, `test/**`, `tools/report.py`, `tools/test_report.py`, `tools/requirements.txt`

**Do not create** `src/insecure-demo.ts` — it belongs to WP4.
**Do not modify** anything listed as pre-built in §2.4. The gate, the toolchain config and the Python dev pins are already done and verified.

### §5.1 Deliverables

1. Express app implementing the §5.3 contract, fully tested.
2. Multi-stage `Dockerfile`, non-root, base image pinned by digest.
3. `public/index.html` — a single static page that calls `/api/version` and `/api/widgets` and renders them. No framework, no build step.
4. `tools/requirements.txt` with the deliberately-outdated pin from §5.6.

`npm run setup` and `npm run gate` already work and the baseline is already green — see §2.4. Your job is to add the application and keep it green. Note that creating `src/app.ts` wakes the `typecheck` and `test` legs, so the application and its tests arrive together or the gate goes red.

### §5.2 Configuration — exact names and defaults

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `APP_ENV` | `local` | environment label surfaced by `/api/version` |
| `APP_VERSION` | `0.0.0-dev` | version label |
| `GIT_COMMIT` | `unknown` | commit SHA label |
| `LOG_LEVEL` | `info` | one of `debug`,`info`,`warn`,`error` |
| `ENABLE_INSECURE_DEMO` | `false` | WP4 gates demo routes on this being exactly `"true"` |

Invalid values fall back to the default and emit one warning. The process must not crash on bad config.

### §5.3 HTTP contract — normative

All responses are `application/json; charset=utf-8` except `GET /` which is `text/html`.

```
Widget := {
  id:        string   // UUID v4
  name:      string   // 1..64 chars after trim
  quantity:  integer  // >= 0
  createdAt: string   // ISO-8601 UTC, e.g. "2026-10-15T17:04:00.000Z"
}
```

| Method & path | Success | Body | Failure |
|---|---|---|---|
| `GET /healthz` | `200` | `{"status":"ok","uptimeSeconds":<number>}` | — |
| `GET /api/version` | `200` | `{"version":<string>,"commit":<string>,"environment":<string>}` | — |
| `GET /api/widgets` | `200` | `{"items":Widget[]}` | — |
| `GET /api/widgets/:id` | `200` | `Widget` | `404` `{"error":"not_found"}` |
| `POST /api/widgets` | `201` | `Widget` | `400` `{"error":"invalid_payload","details":string[]}` |
| `DELETE /api/widgets/:id` | `204` | *(empty)* | `404` `{"error":"not_found"}` |
| `GET /` | `200` | `public/index.html` | — |
| *any unmatched route* | — | — | `404` `{"error":"not_found"}` |

`POST /api/widgets` accepts `{"name":string,"quantity":integer}`. Server generates `id` and `createdAt`; a client-supplied `id` or `createdAt` is ignored, not an error.

Validation failures that must produce `400` with a non-empty `details` array: missing `name`; `name` empty or >64 chars after trim; `quantity` missing, negative, or not an integer.

The `error` **code** strings (`not_found`, `invalid_payload`) are fixed. The `details` strings are free text.

### §5.4 Required tests

At minimum, one test per row of the §5.3 table and one per validation failure in §5.3. Plus: `widgets.ts` domain rules, and `config.ts` default-fallback behaviour. Organisation within `test/` is free (§4.1).

### §5.5 Container requirements

Multi-stage (build → runtime); runtime stage contains no devDependencies; runs as a non-root user; base images pinned by `@sha256:` digest; `EXPOSE 3000`; `HEALTHCHECK` hitting `/healthz`; `.dockerignore` excludes `node_modules`, `.git`, `test`.

### §5.6 Deliberately outdated dependency

Add exactly one npm dependency pinned to a version with a **real published GitHub advisory**, and one such pin in `tools/requirements.txt`. Both must be genuinely imported and reachable — an unused dependency produces no useful Dependabot story. Document both in a `## Intentional findings` section of `README.md` (stub it in WP1; WP4 completes the README).

> If a chosen package's advisory makes the gate fail, pick a different one. A failing gate is S1; a vulnerable dependency is required. Both can be true at once — choose a package whose vulnerability does not break the build.

### §5.7 WP1 acceptance

- [ ] `npm run gate` exits 0, legs 1–5 PASS, legs 6–7 SKIP
- [ ] `npm run gate:test` still exits 0 (26 tests) — proves the harness was not disturbed
- [ ] `docker build -t showcase:dev .` succeeds; `docker run -p 3000:3000 showcase:dev` serves `GET /healthz` → `200 {"status":"ok",...}`
- [ ] Every normative WP1 path in §1.2 exists
- [ ] No pre-built file from §2.4 was modified

---

## §6. WP2 — CI and supply-chain security workflows

**Scope allowlist:** `.github/dependabot.yml`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/workflows/dependency-review.yml`, `.github/workflows/scorecard.yml`, `.github/workflows/container-scan.yml`, `scripts/validate-workflows.mjs`, `package.json` (scripts only)

**Reminder:** these workflows cannot be executed by this loop (§3.4.4). Static validity is the acceptance.

### §6.1 `scripts/validate-workflows.mjs` — the WP2 acceptance mechanism

Scans `.github/workflows/*.yml`. Exits `1` listing every violation, `0` if clean.

| Rule | Check |
|---|---|
| R1 | Every file parses as YAML |
| R2 | Every `uses:` that is not a local `./` path matches `owner/repo(/path)?@<40-hex-sha>` |
| R3 | Every such `uses:` carries a trailing comment naming the human-readable version, e.g. `# v4.2.2` |
| R4 | Every workflow declares a top-level `permissions:` block |
| R5 | No workflow or job uses `permissions: write-all` |
| R6 | Every workflow declares `name:` and at least one trigger |
| R7 | Any job with an `environment:` names one of exactly `dev`, `test`, `prod` |

Rules R1–R7 are the complete set. Do not add more; extra rules create false blockers. The script must report **file and line** for every violation.

### §6.2 Workflows

Pin every action by commit SHA with a version comment (R2/R3). Declare least-privilege `permissions` at workflow level and widen only per-job where genuinely needed.

**`ci.yml`** — triggers: `pull_request`, `push` to `main`. Concurrency group keyed on ref, `cancel-in-progress: true`. Node 24, npm cache. Jobs: install → `npm run gate` → `docker build`. Permissions: `contents: read`.

**`codeql.yml`** — triggers: `pull_request`, `push` to `main`, weekly `schedule`. Matrix `language: [javascript-typescript, python]`. `queries: security-extended`. Permissions: `security-events: write`, `contents: read`, `actions: read`.

**`dependency-review.yml`** — trigger: `pull_request`. `actions/dependency-review-action`, `fail-on-severity: high`. Permissions: `contents: read`, `pull-requests: write`.

**`scorecard.yml`** — triggers: weekly `schedule`, `workflow_dispatch`. OSSF Scorecard, SARIF uploaded to code scanning. Permissions: `security-events: write`, `id-token: write`, `contents: read`.

**`container-scan.yml`** — triggers: `pull_request`, weekly `schedule`. Build image, Trivy scan, SARIF uploaded to code scanning. Permissions: `security-events: write`, `contents: read`.

### §6.3 `dependabot.yml`

Four ecosystems: `npm` (`/`), `pip` (`/tools`), `docker` (`/`), `github-actions` (`/`). Weekly. Minor+patch grouped per ecosystem; majors separate. **Must `ignore` the deliberately-vulnerable pins from §5.6** so they survive for the demo — otherwise Dependabot's own PR removes the thing the demo exists to show.

### §6.4 WP2 acceptance

- [ ] `npm run gate` exits 0 with leg 6 now PASS
- [ ] `npm run gate:test` still exits 0 (26 tests)
- [ ] `node scripts/validate-workflows.mjs` exits 0
- [ ] All six WP2 normative files exist
- [ ] `ci.yml` runs both `npm run gate` and `npm run gate:test`
- [ ] Deliberately-vulnerable pins from §5.6 appear in `dependabot.yml`'s ignore list
- [ ] No pre-built file from §2.4 was modified

---

## §7. WP3 — Mocked CD with environment promotion

**Scope allowlist:** `.github/workflows/cd.yml`, `.github/workflows/rollback.yml`, `scripts/deploy.mjs`, `scripts/smoke.mjs`, `package.json` (scripts only)

### §7.1 The pattern being demonstrated

**Build once, promote one immutable digest through three gates.** Each environment deploys the *same* `sha256:` digest produced by a single build. No environment rebuilds. This is the central idea of the whole demo, and it is enforced as an acceptance item in §7.6 — a deploy job containing `docker build` fails WP3 under §3.1.8.

```
build-and-push ──► image + digest ──► dev (auto) ──► test (gated) ──► prod (approval)
                                       └──────── same digest ────────┘
```

### §7.2 What "mocked deployment" means here

`scripts/deploy.mjs` performs a **real, verifiable local deployment**:

1. Accept `--env <dev|test|prod>`, `--image <ref>`, `--port <n>`.
2. Start the container (or, when `--mock` is passed, the app directly via node) with that environment's variables.
3. Poll `GET /healthz` until `200` or a timeout, then assert `GET /api/version` reports the expected `environment`.
4. Write a deployment record JSON to `.deploy/<env>.json` containing env, image ref, digest, timestamp, and outcome.
5. Exit `0` on success, non-zero with a clear reason on failure.

`--self-test` runs the whole flow against a throwaway port using `--mock`, asserts the record was written, cleans up, and exits 0/1. **This is gate leg 7**, and it is what makes WP3 genuinely verifiable without touching GitHub.

`scripts/smoke.mjs` takes `--base-url` and asserts every §5.3 endpoint behaves correctly. Exits 0/1.

### §7.3 `cd.yml`

Trigger: `push` to `main`, plus `workflow_dispatch`. Permissions: `contents: read`, `packages: write`, `id-token: write`, `attestations: write`.

Jobs, in order:

1. **`build`** — build image, push to GHCR, output the `sha256:` digest as a job output. Generate an SBOM. Produce a build-provenance attestation.
2. **`deploy-dev`** — `needs: build`, `environment: dev`. Runs `deploy.mjs --env dev --image <digest>` then `smoke.mjs`.
3. **`deploy-test`** — `needs: deploy-dev`, `environment: test`. Same, for test.
4. **`deploy-prod`** — `needs: deploy-test`, `environment: prod`. Same, for prod, then publish `public/` to GitHub Pages.

Every deploy job consumes `needs.build.outputs.digest`. None of them runs `docker build`.

### §7.4 `rollback.yml`

Trigger: `workflow_dispatch` only, with inputs `environment` (choice: dev/test/prod) and `digest` (string). Re-runs `deploy.mjs` with the supplied digest against the chosen environment. Same `environment:` gating as `cd.yml`.

### §7.5 Environment configuration

The *GitHub-side* environment objects and their protection rules are created by a human, not by this loop. What this WP owns is that the workflows **reference** `dev`, `test`, `prod` correctly and pass environment-appropriate variables. Document the required protection rules in `DEMO.md` (WP4) so the human can configure them:

| Env | Protection to configure |
|---|---|
| `dev` | none |
| `test` | 5-minute wait timer; deployments from `main` only |
| `prod` | required reviewer; deployments from `main` only |

### §7.6 WP3 acceptance

- [ ] `npm run gate` exits 0 with leg 7 now PASS
- [ ] `npm run gate:test` still exits 0 (26 tests)
- [ ] `node scripts/deploy.mjs --self-test` exits 0 and leaves no stray process or port bound
- [ ] `cd.yml` has exactly one build job, and all three deploy jobs reference the build's digest output
- [ ] No deploy job contains `docker build`
- [ ] `node scripts/validate-workflows.mjs` still exits 0 (R7 now exercised)
- [ ] No pre-built file from §2.4 was modified

---

## §8. WP4 — Governance, planted findings, and demo assets

**Scope allowlist:** `README.md`, `DEMO.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `.github/ISSUE_TEMPLATE/**`, `.github/pull_request_template.md`, `.github/rulesets/main-protection.json`, `src/insecure-demo.ts`, `src/app.ts` (to mount the demo router only)

### §8.1 `src/insecure-demo.ts` — deliberate, required vulnerabilities

Mounted at `/demo/*` **only when `ENABLE_INSECURE_DEMO === "true"`** (§5.2). Default off, so the normal app is clean.

Must contain at least these two, each statically reachable from an exported route handler so CodeQL can trace them:

1. **Command injection** — a handler passing unsanitised request input into `child_process.exec`.
2. **ReDoS** — a handler applying a catastrophically backtracking regex to request input.

Requirements:
- The file opens with a prominent comment block explaining it is intentional demo content and must never be enabled outside the demo.
- Every vulnerable line carries an inline comment naming the vulnerability class.
- Lint rules may be disabled inline here (§3.4.8) — the gate must still pass.
- Reachability matters: code behind an `if (false)` or never-exported is useless, because CodeQL will not flag it.

### §8.2 `README.md`

Customer-facing. Must include: what the repo demonstrates; architecture diagram (Mermaid is fine); quickstart (`npm run setup`, `npm run gate`, `npm start`); the §2 gate explained; a **`## Intentional findings`** table listing every planted item, what it triggers, and why it is there; a pointer to `DEMO.md`.

### §8.3 `DEMO.md` — the runbook

A ~10 minute click-through, numbered, each step naming what to click and what the audience should see:

1. Open a PR → CI, CodeQL, dependency review run in parallel
2. Open a CodeQL alert → use **Copilot Autofix** → accept the suggested patch
3. Attempt to push the synthetic secret → **push protection blocks it at the terminal**
4. Show the unprompted Dependabot PR, its changelog and compatibility score
5. Merge → CD builds once, pushes to GHCR, deploys dev then test
6. Prod pauses for approval → approve live → Pages URL goes green
7. Environments tab → full history, one digest across all three
8. `rollback.yml` → previous digest back in prod in seconds
9. Close on the Security overview, SBOM, and build attestation

Must also contain a **pre-demo setup** section covering: creating the three environments with the §7.5 protection rules, applying `main-protection.json`, and confirming the Security tab shows GHAS enabled.

The synthetic secret for step 3 must be an obviously-fake, non-functional value **given as an instruction to type during the demo — never committed to the repository.**

### §8.4 Governance files

- **`CODEOWNERS`** — `* @johnhain-msft`
- **`SECURITY.md`** — disclosure policy; must state prominently that this is a demo repository containing intentional vulnerabilities and must not be deployed anywhere real.
- **`CONTRIBUTING.md`** — how to run the gate, branch and commit conventions.
- **Issue templates** — bug report + feature request, YAML forms.
- **PR template** — checklist referencing the gate.
- **`.github/rulesets/main-protection.json`** — a valid GitHub ruleset payload for `main`: require PR with 1 approval, require status checks, block force-push, require linear history, require conversation resolution. It is applied by a human; this WP only authors it.

### §8.5 WP4 acceptance

- [ ] `npm run gate` exits 0, all implemented legs PASS
- [ ] `npm run gate:test` still exits 0 (26 tests)
- [ ] With `ENABLE_INSECURE_DEMO=true`, the `/demo/*` routes respond; with it unset, they return `404 {"error":"not_found"}`
- [ ] `src/insecure-demo.ts` contains both §8.1 vulnerability classes, reachable from exported handlers
- [ ] `main-protection.json` is valid JSON with all five rules
- [ ] No real credential anywhere in the working tree or git history
- [ ] Every planted item in §5.6 and §8.1 appears in README's `## Intentional findings` table
- [ ] No pre-built file from §2.4 was modified

---

## Appendix A — `dev-qa-judge` invocations

Run these **one at a time, in order**, confirming each returns PASS before starting the next. `maxRounds: 3` is the default and is appropriate.

> The workflow dispatches dev=`Vasher` (claude-sonnet-5.5), qa=`Wayne` (gpt-6.1-sol), judge=`judge` (claude-opus-5). QA and judge never see the dev's summary — which is exactly why §2 and §3 must carry the acceptance criteria rather than the dev's report.

### WP1

```
task:
Implement Work Package 1 (WP1) of the GitHub CI/CD showcase repository.

The complete normative specification is at C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo/SPEC.md.
Read §0, §1, §2, §3 and §4 — they are binding on every work package — then read §5, which is WP1.
Do not read or implement §6, §7 or §8; those are later work packages.

Repository root: C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo

THE GATE AND TOOLCHAIN ARE ALREADY BUILT AND ALREADY GREEN. Read §2.4 carefully before
you touch anything. scripts/gate.mjs, scripts/setup.mjs, scripts/gate.test.mjs,
eslint.config.js, tsconfig.json, vitest.config.ts, tools/requirements-dev.txt and the
"scripts" block of package.json are PRE-BUILT and MUST NOT BE MODIFIED — modifying any of
them is an S1 finding under §3.1.9. If you believe the gate is wrong, say so in your
summary rather than editing it.

Run `npm run setup` once, then `npm run gate`. It currently reports 3/3 legs passed,
4 skipped, exit 0 — a clean green baseline with nothing to tidy up. The typecheck and test
legs are skipped because src/app.ts does not exist yet; creating it wakes BOTH of them, so
the application and its tests must arrive together or the gate goes red.

§2.4 also lists toolchain facts worth knowing before you start — notably that relative
imports must carry the .js extension, that noUncheckedIndexedAccess is on, and that src/
and test/ do not exist yet because git does not track empty directories.

Acceptance is exactly §2 and §5.7: `npm run gate` exits 0 with legs 1-5 PASS and legs 6-7
SKIP, `npm run gate:test` still exits 0 with 26 tests passing, and every file marked
(normative — WP1) in §1.2 exists.
§3 governs what may be reported as blocking; §3.4 lists things that are not findings at all.
Take no GitHub-side action. Local commits only.

scope:
Only these paths may be created or modified: package.json (to ADD dependencies only — never
to change the "scripts" block or re-pin the existing devDependencies), package-lock.json,
Dockerfile, .dockerignore, LICENSE, README.md (stub only), src/**, public/**, test/**,
tools/report.py, tools/test_report.py, tools/requirements.txt.
Do not create src/insecure-demo.ts — it belongs to WP4.
Do not modify SPEC.md, scripts/**, eslint.config.js, tsconfig.json, vitest.config.ts,
or tools/requirements-dev.txt.
```

### WP2

```
task:
Implement Work Package 2 (WP2) of the GitHub CI/CD showcase repository.

The complete normative specification is at C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo/SPEC.md.
Read §0, §1, §2, §3 and §4 — binding on every work package — then read §6, which is WP2.
Do not implement §5, §7 or §8. WP1 is already complete; do not redo or refactor it.

Repository root: C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo

Acceptance is exactly §2 and §6.4: `npm run gate` must exit 0 with leg 6 now PASS, and
`node scripts/validate-workflows.mjs` must exit 0.

These workflows CANNOT be executed by this loop — it takes no GitHub action by design.
Static validation is the acceptance. Per §3.4.4, "not proven to run in CI" is not a finding.
Take no GitHub-side action. Local commits only.

scope:
Only these paths may be created or modified: .github/dependabot.yml,
.github/workflows/ci.yml, .github/workflows/codeql.yml, .github/workflows/dependency-review.yml,
.github/workflows/scorecard.yml, .github/workflows/container-scan.yml,
scripts/validate-workflows.mjs, and the "scripts" section of package.json.
Do not modify SPEC.md or any WP1 source file.
```

### WP3

```
task:
Implement Work Package 3 (WP3) of the GitHub CI/CD showcase repository.

The complete normative specification is at C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo/SPEC.md.
Read §0, §1, §2, §3 and §4 — binding on every work package — then read §7, which is WP3.
Do not implement §5, §6 or §8. WP1 and WP2 are already complete; do not redo or refactor them.

Repository root: C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo

Acceptance is exactly §2 and §7.6: `npm run gate` must exit 0 with leg 7 now PASS, and
`node scripts/deploy.mjs --self-test` must exit 0 leaving no stray process or bound port.

The central requirement is §7.1: build the image ONCE and promote the SAME sha256 digest
through dev, test and prod. No deploy job may run `docker build`.
Per §3.4.5, the deployment being mocked is the specified design, not a shortfall.
Take no GitHub-side action. Local commits only.

scope:
Only these paths may be created or modified: .github/workflows/cd.yml,
.github/workflows/rollback.yml, scripts/deploy.mjs, scripts/smoke.mjs, and the "scripts"
section of package.json. Do not modify SPEC.md or any WP1/WP2 file.
```

### WP4

```
task:
Implement Work Package 4 (WP4) of the GitHub CI/CD showcase repository.

The complete normative specification is at C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo/SPEC.md.
Read §0, §1, §2, §3 and §4 — binding on every work package — then read §8, which is WP4.
WP1, WP2 and WP3 are already complete; do not redo or refactor them.

Repository root: C:/Users/johnhain/Documents/ip-kits/github_pipeline_demo

Acceptance is exactly §2 and §8.5.

This work package DELIBERATELY ADDS VULNERABLE CODE in src/insecure-demo.ts. That is required
product, not a defect — see §3.4.1 and §8.1. The vulnerabilities must be genuinely reachable
from exported route handlers or CodeQL will not detect them, which would defeat the demo.
They are gated behind ENABLE_INSECURE_DEMO === "true" and are off by default.
The synthetic demo secret is an instruction to type during the demo and must NEVER be
committed to the repository.

This repository is customer-facing: no internal URLs, no real tenant/subscription/account IDs,
no customer names, in files or in git history.
Take no GitHub-side action. Local commits only.

scope:
Only these paths may be created or modified: README.md, DEMO.md, SECURITY.md, CONTRIBUTING.md,
CODEOWNERS, .github/ISSUE_TEMPLATE/**, .github/pull_request_template.md,
.github/rulesets/main-protection.json, src/insecure-demo.ts, and src/app.ts (solely to mount
the demo router). Do not modify SPEC.md.
```

---

## Appendix B — human steps, outside the loop

These require a GitHub write and must be done by a person after WP4 passes.

1. Create `ms-mfg-community/github-pipeline-showcase` as **private**.
2. Confirm the Security tab shows Advanced Security, secret scanning, and push protection enabled.
3. Push `main`.
4. Create environments `dev`, `test`, `prod` with the §7.5 protection rules.
5. Apply `.github/rulesets/main-protection.json`.
6. Enable GitHub Pages for the prod deployment target.
7. Walk `DEMO.md` end-to-end once before showing it to anyone.
