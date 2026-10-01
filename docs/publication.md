# Public source publication

The public source repository is https://github.com/humansinstitute/level-up.

The first public release uses a reviewed source snapshot, without the private
development history. Local `main` retains that history; `github-public` is the
public history and maps to GitHub `main` through the `github` remote. Never push
local `main`, all branches, tags, or a mirror to that remote.

For subsequent publications, review the full tracked tree and differences from
`github-public`, then create a new publication commit with the reviewed tree and
`github-public` as its parent. Advance `github-public` and push only
`github-public:main`. Preserve private development history and local data.

Before every publication:

- Verify ignore rules and ensure no ignored files remain tracked.
- Exclude environment files except the blank example, database files, runtime
  data, operational handoffs, screenshots, logs, credentials, and scratch work.
- Inspect source, documents, assets, commit messages, and author metadata for
  private information. Use a GitHub no-reply address for public commits.
- Scan the exact public tree and reachable public history with Gitleaks.
- Run `bun run check` and `git diff --check`.
- Check the target repository and remote branch before pushing, then verify
  the remote hash afterwards.

Public owner Nostr identifiers used by the application's authorization policy
are public keys, not signing secrets. Synthetic test fixtures are not credentials.
The Gitleaks allowlist is limited to one exact synthetic invite value in its two
test files; it must never be broadened to suppress real credentials.

Publishing source does not activate or restart the running application.
