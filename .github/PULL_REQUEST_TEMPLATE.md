## Summary

What does this PR change, and why?

## Checklist

- [ ] `cd app && npm run build:all` passes
- [ ] Both typechecks pass: `npx tsc -p tsconfig.main.json --noEmit` and `npx tsc -p tsconfig.renderer.json`
- [ ] Self-evolution engine still imports (`python -c "import sys; sys.path.insert(0,'server/vendor'); import evolution.skills.evolve_skill"`)
- [ ] No secrets, `node_modules/`, build output, or `~/.hermes-mo/` data committed
- [ ] No third-party code under non-permissive licenses added (and `THIRD_PARTY_LICENSES/` updated if I vendored anything); no font binaries
- [ ] Docs / CHANGELOG updated if behavior changed
