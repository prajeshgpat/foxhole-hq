# Changesets

Every PR that changes a package adds a changeset: run `pnpm changeset`, pick the packages and the bump
(patch, minor, major), and write one line for the changelog. When the PR reaches `main`, the release
workflow turns pending changesets into version bumps, changelogs and git tags.
