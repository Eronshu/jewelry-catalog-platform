# Engineering Rules

- Read PROJECT_SPEC.md before making architectural or product decisions.
- Do not commit secrets, credentials, tokens, passwords, or production data.
- Keep main deployable.
- Feature work must happen on feature branches.
- Prefer small, focused changes.
- Do not change the agreed architecture without explaining why first.
- Every meaningful feature should include appropriate tests.
- Before declaring work complete, run lint, typecheck, tests, and production build.
- Database changes must use migrations.
- Admin UX is designed for a non-technical business owner.
- Mobile Safari is a first-class supported platform.
- Destructive production actions require explicit human approval.
- Finish one reviewable task per feature branch: commit, open a PR, then wait for CI and review. Do not add the next task before that PR is reviewed and merged. Start the next task from updated main.
- The user has delegated merging small, focused local-development/documentation PRs after the current head passes CI and independent review with no unresolved findings. Verify the reviewed head at merge, check the merged tree, archive unique local commits/files before branch cleanup, and update main before starting the next task. This does not authorize deployment, production resources, billing, live payments or business-policy decisions.
- Follow `docs/COMMERCE_PR_SEQUENCE.md` for the existing commerce series. Never merge the original backup as a shortcut. After all four PRs are reviewed, merged and checked for omissions, user-authorized cleanup may remove the backup and old branches/worktrees; archive unique commits and uncommitted files first. Create C09b from updated main only after the series is merged.
