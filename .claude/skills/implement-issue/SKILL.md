---
name: implement-issue
description: 'Implement one GitHub issue of the unity-asset-reader project end to end - read the issue and plan, study the upstream AssetStudio/UnityPy reference, write the code and tests following the project rules, verify, and open a PR. Use this whenever the user gives an issue number to work on ("implement #12", "do issue 17", "pick up the LZ4 task", "start M1", "/implement-issue 12"), or asks to build any feature that is tracked as an issue in this repo, even if they do not say "skill".'
argument-hint: <issue-number>
---

# Implement an issue

Input: one issue number (`$ARGUMENTS`). If none was given, list open non-epic issues of the earliest unfinished milestone (`gh issue list --state open`) and ask which one.

The goal is a PR that a strict reviewer can approve without discussion: it does exactly what the issue asks, obeys the project rules, and proves each acceptance criterion with a test. The `review-implementation` skill will check the result against the same documents you are about to read, so reading them is the cheapest way to pass.

## 1. Understand the work

Read, in this order:

1. The issue, including comments (decisions often land there, for example the LZMA spike result):
   ```bash
   gh issue view <N> --json number,title,body,labels,state,comments
   ```
2. `docs/unity-asset-reader-rules.md` - the rules you will be reviewed against. Read it fully, every time; it is short.
3. The parts of `docs/unity-asset-reader-plan.md` the issue touches: the locked decisions (§0), the milestone entry, and §5 if tests use fixtures.
4. `CONTRIBUTING.md` if you have not seen it in this session.

Then stop and check three things before writing code:

- **Is it an epic?** (label `epic`, title starts with `[M`). Epics are not implemented directly. List its open sub-issues and ask which to take:
  ```bash
  gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){subIssues(first:50){nodes{number title state}}}}}' -F o='{owner}' -F r='{repo}' -F n=<N>
  ```
- **Are its dependencies done?** Look for "Depends on #X", "Blocks", "per the decision in #X" in the body, and for code the issue obviously builds on. If a dependency is still open, say so and ask whether to do the dependency first. Building on code that does not exist yet produces stubs that the real implementation later has to fight.
- **Does the issue contradict the plan or the rules?** If yes, do not pick a side silently. Tell the user what conflicts and propose the fix (usually: edit the issue).

## 2. Study the reference

Most issues have a `## Port` section naming AssetStudio files. Those files define the behavior. Clone the references **outside the repo** - rule R2 forbids C# inside it, and the CI guard will fail on a stray `.cs` file:

```bash
REF="${TMPDIR:-/tmp}/uar-ref"; mkdir -p "$REF"
[ -d "$REF/assetstudio" ] || gh repo clone Razviar/assetstudio "$REF/assetstudio" -- --depth 1
[ -d "$REF/UnityPy" ] || gh repo clone K0lb3/UnityPy "$REF/UnityPy" -- --depth 1
```

Read the named files completely, plus whatever they call that affects bytes (alignment helpers, version checks). UnityPy's Python is usually the easier read for the same logic; when the two disagree, AssetStudio is the source of truth and the disagreement is worth a line in the PR.

What to carry over: behavior on the same bytes - field order, version gates, alignment, error conditions. What to leave behind: C# structure - stream classes, inheritance layers, helper indirection. Never look at `@arkntools/unity-js` (R1).

## 3. Branch

```bash
git checkout main && git pull --ff-only && git checkout -b feature/<N>-<short-slug>
```

If the working tree is dirty with unrelated changes, stop and ask; do not stash or discard someone's work.

## 4. Implement

- Work inside the package the issue belongs to (`packages/core`, `packages/texture`, `packages/node`) following plan §2; respect the dependency direction (R14). (If `packages/` does not exist yet, the M0 workspaces and scaffold issues have to come first.)
- Go through the issue's **Tasks** list top to bottom. Write the smallest code that satisfies them. Anything adjacent that looks worth doing goes into a follow-up issue, not into this PR - reviewers reject scope creep because it hides the change they are trying to verify.
- Ported files start with the attribution line from R3.
- Match the style rules in the rules doc (double quotes, semicolons, JSDoc on exports, version-gate comments that cite the Unity version).
- Tests: every **Acceptance** bullet gets at least one test that would fail if the behavior broke, including the unhappy paths the issue names. Fixture goldens come from the oracle script, never from your own output (R12). If the golden harness (#20) is not in place yet and the issue needs it, say so rather than inventing goldens.

Some issues deliver a decision instead of code (spikes such as #13). For those, the deliverable is a comment on the issue recording the measurements and the decision, plus whatever small script produced the numbers. Post the comment only after showing it to the user.

## 5. Verify

Run the verification block from the rules doc and read the output, do not assume:

```bash
npm ci && npm run verify
```

From the repo root; it includes the no-C# guard. If you touched `packages/texture2ddecoder-wasm/`, also run its tests with `wasm/` built (`npm test -w texture2ddecoder-wasm`).

Then self-review the diff (`git diff main...`) against the Hard rules table, one ID at a time. It takes a minute and catches most of what the reviewer would.

If something fails and you cannot fix it within the issue's scope, do not paper over it (no skipped tests, no loosened assertions). Report it.

## 6. Commit, push, open the PR

Commits: imperative subject ≤ 50 chars, one logical change each, body says why.

```bash
git push -u origin HEAD
gh pr create --title "<issue title> (#<N>)" --body-file <file>
```

PR body template:

```markdown
Closes #<N>

## What
<2-4 lines: what was built and the one or two decisions worth knowing>

## Acceptance
| Criterion (from the issue) | Proof |
|---|---|
| <bullet, verbatim> | `tests/<file>.test.ts` › "<test name>" |

## Verification
build ✅ · test ✅ (<n> passed) · check:browser ✅ · no-C# guard ✅

## Reference
Ported from: <AssetStudio files>. Differences from upstream: <none | list>

## Deviations
<None | what differs from the issue/plan and why>

## Follow-ups
<None | #issue links>
```

Do not merge. Finish by telling the user the PR URL, anything in Deviations, and that `review-implementation` can now check it.
