<!--
Before opening a PR against siteboon/claudecodeui:
1. Search existing issues/PRs first (title + body) to avoid duplicating work.
   Link the issue this closes, if any.
2. Work on a dedicated branch per feature/fix, not `main` directly, e.g.
   feat/<short-name> or fix/<short-name> — matches this fork's existing
   contributions (feat/command-code-provider, fix/cursor-agent-binary-resolution,
   fix/plugin-install-include-dev).
3. Commit to this fork's `main` (kept in sync with upstream), then open the
   PR as: base `siteboon/claudecodeui:main` ← head
   `asiqur-rahman:<your-branch>`. Creating a cross-repo PR needs a classic
   PAT with the `public_repo` scope — a fine-grained PAT can't be scoped to
   a repo you don't own/administer.
4. Keep the PR scoped to one feature/fix. Don't bundle unrelated changes.
5. Run npm run typecheck, npm run lint, npm test, npm run test:client, and
   npm run build before opening — paste the results in Testing below.
-->

## What

<!-- What does this PR add or change? -->

## Closes

<!-- Link the issue this addresses, e.g. Closes #123. Omit this section if none. -->

## Why not the existing approach/PR

<!-- Only if a prior PR/attempt exists for this: what did it miss or get
     wrong, and how does this one avoid the same issues? Omit if not applicable. -->

## Known limitations

<!-- Anything intentionally out of scope, or a pre-existing behavior this PR
     inherits without fixing. Omit if none. -->

## Testing

<!-- Paste actual command output/results, not just "tests pass". -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test` (server)
- [ ] `npm run test:client`
- [ ] `npm run build`
