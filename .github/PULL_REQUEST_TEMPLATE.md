## Summary

What does this PR change, and why?

## Checklist

- [ ] `cd app && npm run build:all` passes
- [ ] Self-evolution engine still imports (`python -c "import sys; sys.path.insert(0,'server/vendor'); import evolution"`)
- [ ] No secrets, `node_modules/`, build output, or `~/.hermes-mo/` data committed
- [ ] No third-party code under non-permissive licenses added (and `THIRD_PARTY_LICENSES/` updated if I vendored anything)
- [ ] Docs / CHANGELOG updated if behavior changed
