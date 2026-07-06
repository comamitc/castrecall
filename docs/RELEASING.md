# Releasing CastRecall

CastRecall ships as an npm-style package (`@comamitc/castrecall`) installable
from GitHub today and, once published, from ClawHub. This is the runbook for
cutting a release.

## 1. Bump the version

- Bump `version` in `package.json`.
- Add a `## vX.Y.Z — <date>` entry to `CHANGELOG.md` in the established
  format (prose lead + bulleted PR references).

## 2. Regenerate and verify the plugin manifest

```bash
npm run build
npx openclaw plugins build --entry ./dist/index.js
```

`plugin:build` regenerates `openclaw.plugin.json` (`version`, `icon`, tool
contracts) from `package.json` and the built entry point — never hand-edit
its generated fields.

Verify the repo is a fixed point (no drift between source and the committed
manifest):

```bash
npx openclaw plugins build --entry ./dist/index.js --check   # must exit 0
git diff                                                       # must be empty
```

CI runs the same `--check` step on every PR, so this should already be clean
before you open the release PR.

## 3. Validate and test

```bash
npm run plugin:validate
npm test
```

## 4. Confirm packaging

```bash
npm pack --dry-run
```

Confirm the tarball listing includes `assets/icon.svg` (via `files` in
`package.json`) — the icon must ship in the published package, not just live
in git.

## 5. Tag and publish the GitHub release

Follow the existing release-PR flow: release PR → CI green → merge → tag →
`gh release create` → close the milestone.

## 6. Publish to ClawHub (maintainer-only, credentialed)

```bash
npm i -g clawhub
clawhub login
clawhub whoami                                          # confirm publish owner is @comamitc
clawhub package publish comamitc/castrecall --dry-run    # validates scope/name/version/files
clawhub package publish comamitc/castrecall
```

New releases are hidden from ClawHub's install/download surfaces until
ClawHub's automated security review finishes. Do not treat `publish` as done
until the listing is visible at `https://clawhub.ai/comamitc/...`.

If `clawhub whoami` reports a different owner handle than `comamitc`, the
package scope (`@comamitc/castrecall`) won't match — either publish under the
correct owner or rename the package scope in a follow-up commit; see
[ClawHub publishing](https://clawhub.ai) scope-mismatch guidance.

## 7. Verify the icon resolves (post-merge only)

The manifest `icon` field points at a raw-GitHub URL under `assets/icon.svg`,
which only resolves once the asset has landed on `main`:

```bash
curl -sI https://raw.githubusercontent.com/comamitc/castrecall/main/assets/icon.svg
# expect HTTP/2 200, content-type image/svg+xml
```

## 8. Flip the README to ClawHub as the primary install path

Once the ClawHub listing is live and installable, update the "Install"
section of `README.md` so `openclaw plugins install clawhub:comamitc/castrecall`
is the primary path, with the `git:github.com/...@main` form kept as a
fallback for pre-review or offline installs.
