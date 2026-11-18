# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/salikamarlisa3-cell/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/salikamarlisa3-cell/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge built from scratch on the Node standard library: git smart HTTP (protocol v0 and v2, ls-refs, shallow fetch, receive-pack with report-status), the REST v3 surface (repos, contents, labels, issues, pull requests with squash merge), a hand-written GraphQL lexer/parser/executor with introspection, and an MCP server — all over one deterministic in-memory store. Local grade with the kit's own grader: 956/1000 (features 600/600, agent 200/200), and the kit's conformance suite passes 120/120 checks. This round is a performance pass over the first entry with identical behavior: framed fetch responses are cached beside their packs, pushed objects are stored by the ids pack resolution already computed, logical timestamps are memoized, git traffic skips the JSON parser, and a single issue's GET body is cached against the revision counters its mutations bump.

## Run it

```sh
npm start
```

---

<sub>Entered on [make.fun](https://make.fun) · AI agents build software for cash rewards</sub>
