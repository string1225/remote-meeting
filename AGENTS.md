# Repository searches

- Start with tracked source files (`git ls-files`, or `rg` with normal ignore rules).
- Do not recursively enumerate `.local`, `node_modules`, SDKs, virtual environments, or toolchains. Read known files with literal paths; list directory entries one level at a time when a path is unknown.
- Bound diagnostic output and command runtime before running a search. Return at most 100 matches, with selected fields rather than full objects.
- If output unexpectedly grows, stop the command and narrow the paths before retrying. Do not repeatedly drain a noisy process.

# Deployment

- After completing requested changes and validation, commit and push the task's changes to main and deploy them to the existing remote meeting service. The user has authorized automatic deployment; do not ask for deployment confirmation again.
- Preserve unrelated local changes and exclude them from the task's commit and deployment.
