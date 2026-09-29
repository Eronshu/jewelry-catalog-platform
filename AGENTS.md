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