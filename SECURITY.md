# Security policy

> **This is a demonstration repository. It contains intentional vulnerabilities and deliberately
> outdated dependencies. Do not deploy it anywhere real, and do not copy its demo code into another
> project.**

## What is vulnerable on purpose

The repository exists to show GitHub's security tooling finding real problems. These are known,
documented and out of scope for reports:

| Item | Where | Notes |
|---|---|---|
| Command injection (CWE-78) | `src/insecure-demo.ts`, `GET /demo/echo` | Reachable only when `ENABLE_INSECURE_DEMO` is exactly `true` |
| Regular-expression denial of service (CWE-1333) | `src/insecure-demo.ts`, `GET /demo/validate` | Same switch |
| `morgan@1.10.1` | `package.json` | Three published advisories, all fixed in 1.12.1 |
| `requests==2.31.0` | `tools/requirements.txt` | Three published advisories, all fixed in 2.33.0 |

The demo routes are off by default. While `ENABLE_INSECURE_DEMO` is anything other than `true`,
`/demo/*` answers `404 {"error":"not_found"}`. The deploy script sets it to `false` for every
environment it deploys to, and nothing in the pipeline turns it on. Never switch it on outside a
machine you control and a demonstration you are running yourself.

The README's "Intentional findings" section has the full list, with advisory links.

## What to report

Please do report anything that is not on that list, for example:

- a vulnerability in a workflow, a script or the container image that is not one of the findings above
- a way for the demo routes to be enabled by default, or to be reached while the switch is off
- a real credential, token or private key committed to the repository or its history

If you think a real secret was committed, treat it as compromised: revoke it with the provider that
issued it first, then report it.

## How to report

Report privately, not in a public issue or pull request. If private vulnerability reporting is
enabled for the repository, use **Report a vulnerability** on the repository's Advisories page. If
you cannot see that option, open an issue that says you have a security report and asks for a
private way to send it, and leave the details out of the issue.

## What to expect

This is a demonstration maintained on a best-effort basis. There is no response-time commitment and
no supported release: only the `main` branch is maintained, and nothing here is a product.
