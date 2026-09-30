# Jewelry Catalog Platform

A Cloudflare-native React Router application for a small-business jewelry
catalog and its future owner-facing administration tools. The V1 product scope
and architecture are defined in [PROJECT_SPEC.md](./PROJECT_SPEC.md).

Issue #1 establishes only the production application scaffold. Catalog data,
image storage, authentication, admin features, and deployment are intentionally
not configured yet.

## Requirements

- Node.js 24.21.0 (see `.node-version`)
- npm

Use a Node version manager that understands `.node-version`, or install the
documented version directly. The project also declares the supported Node range
in `package.json`.

## Local setup

```sh
npm ci
npm run dev
```

The development server uses the Cloudflare Vite plugin so server code runs in a
local Workers-compatible runtime. No environment values are currently required;
`.env.example` documents the policy for adding them later.

Never commit `.env`, `.dev.vars`, Cloudflare tokens, account identifiers, or
production data. Browser-visible values must be treated as public. Future
server-only secrets should be stored locally in `.dev.vars` and in Cloudflare's
secret management for deployed environments.

## Commands

| Command                | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | Start the local Cloudflare-compatible development server   |
| `npm run build`        | Create the production client and Worker bundles            |
| `npm run preview`      | Preview the production build locally for manual validation |
| `npm run format`       | Format project files                                       |
| `npm run format:check` | Check formatting without changing files                    |
| `npm run lint`         | Run ESLint                                                 |
| `npm run typecheck`    | Generate platform/route types and run TypeScript checks    |
| `npm test`             | Run the test suite once                                    |
| `npm run test:watch`   | Run tests in watch mode                                    |
| `npm run validate`     | Run all non-interactive validation checks and the build    |

## Project structure

- `app/` — React Router application shell, routes, and styles
- `workers/` — Cloudflare Worker entry point
- `.github/workflows/` — validation-only continuous integration

## Deployment

Deployment is not configured by Issue #1. The production build targets
Cloudflare Workers and Static Assets, but no Cloudflare resources, live
bindings, preview deployments, production deployments, or credentials are
created by this scaffold.
