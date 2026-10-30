# Contributing

## Branches

| Branch                       | Purpose                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `main`                       | What is released. Only changes through a reviewed PR from `dev` with green CI. Every push runs the release workflow. |
| `dev`                        | Integration branch. Day-to-day work lands here.                                                                      |
| `feat/*`, `fix/*`, `chore/*` | Optional short-lived branches off `dev` for larger changes, merged back by PR.                                       |

After a release, `main` is merged back into `dev` so version bumps and changelogs stay in sync.

## Workflow

1. Branch from `dev` (or commit to it for small changes).
2. Make the change with tests. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
3. If a package changed, run `pnpm changeset` and describe the change in one line.
4. If you touched `packages/agent`, commit the rebuilt `packages/plugin-claude/dist/foxhole.mjs`. CI fails if it is stale.
5. Open a PR into `dev`. When `dev` is ready to ship, open a PR from `dev` into `main`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

## Releases

Handled by [Changesets](https://github.com/changesets/changesets) in `.github/workflows/release.yml`:

1. A push to `main` with pending changesets opens or updates a **Version packages** PR.
2. Merging that PR bumps versions, writes `CHANGELOG.md` files, tags each package and creates GitHub releases.

## Privacy rules

Foxhole's promise is metadata only. Any change that touches what an event contains must:

- keep the schema strict (no free-form fields),
- add tests showing secrets, prompts and file contents do not end up in events,
- update the privacy section of PLAN.md (in this folder) if the set of fields changes.
