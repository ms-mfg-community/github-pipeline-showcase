# Contributing

This repository is a demonstration of a GitHub CI/CD pipeline around a deliberately small service.
Changes that keep the service simple and make the pipeline clearer or easier to demonstrate fit best.
Read the "Intentional findings" section of the [README](README.md) before you start: some of what
looks wrong here is there on purpose.

## What you need

- Node.js 24 or newer
- Python 3, for the dev tooling in `tools/` (`npm run setup` puts it in a project-local `.venv`)
- Docker, only if you want to build or run the container image

## Run the gate before you open a pull request

```sh
npm run setup      # once per machine: install Node dependencies, create .venv with the Python dev tooling
npm run gate       # lint, typecheck, unit tests, Python lint and tests, workflow validation, deploy self-test
npm run gate:test  # the gate's own test suite
```

`npm run gate` is the definition of "it works" for this repository. It runs every leg, prints one
line per leg and exits non-zero if any leg failed. `npm run gate:list` shows the legs. CI runs the
same two commands on every pull request, so a pull request that is red locally will be red there.
If the gate was green on `main` and is red on your branch, your change caused it.

Docker is not one of the legs, because a gate that needs it would not be reproducible everywhere.
The image is built by the `Docker build` job in CI.

## Branches and merging

`main` is protected by the ruleset in [.github/rulesets/main-protection.json](.github/rulesets/main-protection.json).
It expresses five requirements:

- changes arrive through a pull request, with one approval
- the required status checks pass
- every conversation on the pull request is resolved
- history stays linear, so a pull request is squash-merged or rebased, never merged with a merge commit
- nobody force-pushes to `main`

(GitHub carries these as four rule types: `pull_request` holds both the approval count and the
conversation rule, and the other three are one rule each.)

Work on a topic branch named `<type>/<short-description>`, for example `fix/health-timeout` or
`docs/demo-runbook`, and keep each pull request to one change. Fill in the pull request template:
its checklist is the same gate described above.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type: subject`.

| Type | Use it for |
|---|---|
| `feat` | a new capability |
| `fix` | a bug fix |
| `docs` | documentation only |
| `test` | tests only |
| `ci` | workflows and other pipeline definitions |
| `chore` | repository housekeeping, such as templates and ownership files |
| `refactor` | a change that alters structure but not behavior |

Write the subject in the imperative and keep it short, for example
`fix: end the health wait at its deadline`. Use the body to explain why, not what.

## Tests

- TypeScript tests live in `test/` (and `src/**/*.test.ts`) and run under Vitest: `npm test`.
- Python tests live next to the code in `tools/` and run under pytest. `npm run gate` runs them.
- A behavior that is written down in the README, `SPEC.md` or a workflow should have a test or a
  gate leg that would notice if it stopped being true.

## Workflows

Every `uses:` in `.github/workflows` is pinned to a full commit SHA with a trailing version comment,
for example `# v4.2.2`, and every workflow declares a top-level `permissions:` block. Dependabot keeps
the SHAs current. The gate's workflow-validation leg checks these rules, so run it after editing a
workflow.

## The intentional findings

This repository carries vulnerabilities and outdated dependencies on purpose, so that code scanning,
dependency scanning and secret scanning have something real to show:

- `src/insecure-demo.ts`, a command injection and a ReDoS, reachable only when `ENABLE_INSECURE_DEMO`
  is exactly `true` (off by default, and forced off by `scripts/deploy.mjs`)
- `morgan@1.10.1` in `package.json`
- `requests==2.31.0` in `tools/requirements.txt`, which `.github/dependabot.yml` ignores so that
  Dependabot does not replace it

Please do not fix these in a drive-by change, and do not widen them. If a change touches one, say so
in the pull request and update the table in the README.

## Reporting a security problem

Do not open an issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
