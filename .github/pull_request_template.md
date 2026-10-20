## Summary

<!-- What does this change, and why? A sentence or two is enough. -->

## How it was tested

<!-- The commands you ran and what you saw. -->

## Checklist

- [ ] `npm run gate` exits 0. Every leg that applies shows PASS (a leg shows SKIP only when its artifact does not exist).
- [ ] `npm run gate:test` exits 0.
- [ ] Commit subjects follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `ci:` or `chore:`.
- [ ] README.md and DEMO.md are updated if behavior or setup changed.
- [ ] No secrets, tokens, internal URLs or customer details are included.
- [ ] If `.github/workflows` changed: every action is pinned to a full commit SHA with a version comment, and permissions stay least-privilege.
- [ ] The intentional findings listed in the README are untouched, or this description says why they changed.
