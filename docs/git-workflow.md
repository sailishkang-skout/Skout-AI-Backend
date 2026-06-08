# Skout AI — Git Branching & Release Workflow

This document describes how developers create branches, open pull requests, promote code through environments, and name releases. It matches the long-lived branches and GitHub Actions workflows in this repo.

For environment details (AWS stacks, env files, secrets), see [deployment-environments.md](./deployment-environments.md).

---

## Branch model

Skout uses **three long-lived branches**. Each branch maps to one deployment environment.

| Branch | Environment | Auto-deploy | Purpose |
|--------|-------------|-------------|---------|
| `develop` | **Dev** | Yes (`deploy-dev.yml`) | Integration branch — all feature work lands here first |
| `uat` | **UAT / sandbox** | Yes (`deploy-uat.yml`, coming soon) | Pre-production validation with stakeholders |
| `main` | **Production** | Yes (`deploy-prod.yml`) | Production-ready code only |

```
feature/* ──PR──► develop ──PR──► uat ──PR──► main
                     │              │           │
                   Dev AWS        UAT AWS    Prod AWS
```

**Rules**

- Never commit directly to `main`, `uat`, or `develop` (except hotfixes — see below).
- All day-to-day work happens on **short-lived branches** branched from `develop`.
- Code flows **one direction**: `develop` → `uat` → `main`. Do not merge `main` back into feature branches except when resolving conflicts during a release.

---

## Creating a development branch

### 1. Start from an up-to-date `develop`

```bash
git checkout develop
git pull origin develop
```

### 2. Create your branch

```bash
git checkout -b <type>/<ticket>-<short-description>
```

### Branch naming convention

Use lowercase, hyphen-separated words. Include the ClickUp task ID when one exists.

| Type | When to use | Pattern | Example |
|------|-------------|---------|---------|
| `feature/` | New functionality | `feature/<task-id>-<description>` | `feature/S1-012-jwt-auth-middleware` |
| `fix/` | Bug fix (non-production) | `fix/<task-id>-<description>` | `fix/S2-004-search-pagination` |
| `chore/` | Tooling, deps, CI, docs | `chore/<description>` | `chore/update-cdk-deps` |
| `refactor/` | Code change, no behavior change | `refactor/<description>` | `refactor/extract-search-service` |
| `hotfix/` | Urgent production fix | `hotfix/<description>` | `hotfix/credit-deduction-race` |

**Examples from MVP sprints**

```bash
git checkout -b feature/S1-011-migration-002
git checkout -b feature/S1-015-list-crud
git checkout -b fix/S1-017-list-member-validation
```

### 3. Work locally

```bash
pnpm install
pnpm test          # runs before commit via Husky
pnpm typecheck
pnpm dev
```

Keep commits small and focused. Write commit messages in the imperative mood:

```
Add JWT auth middleware for protected routes
Fix list member duplicate key on re-add
Update deployment docs for UAT branch
```

### 4. Push and open a pull request

```bash
git push -u origin feature/S1-012-jwt-auth-middleware
```

Open a PR in GitHub **targeting `develop`**.

---

## Pull requests & merging

### PR targets

| Your branch type | Merge into | Review required |
|------------------|------------|-----------------|
| `feature/*`, `fix/*`, `chore/*`, `refactor/*` | `develop` | 1 teammate |
| Release promotion | `uat` or `main` | Tech lead / release owner |

### Before requesting review

- [ ] CI passes (tests, typecheck, Docker build, CDK synth)
- [ ] Branch is rebased or merged with latest `develop`
- [ ] No secrets or `.env` files committed
- [ ] Database migrations included if schema changed
- [ ] PR description links the ClickUp task

### PR title format

```
[S1-012] Add JWT auth middleware
```

Or without a ticket:

```
Add OpenSearch index mapping for prospect search
```

### Merge strategy

Use **Squash and merge** for feature branches into `develop`. This keeps `develop` history clean and maps one PR to one logical change.

Use **Merge commit** (or squash, team preference) when promoting `develop` → `uat` → `main` so release boundaries stay visible.

### After merge

```bash
git checkout develop
git pull origin develop
git branch -d feature/S1-012-jwt-auth-middleware   # delete local branch
```

Deleting the remote branch after merge is recommended (GitHub can do this automatically in repo settings).

### What happens on merge

| Target branch | CI | Deploy |
|---------------|-----|--------|
| `develop` | ✅ Runs | ✅ Auto-deploys to **Dev** AWS |
| `uat` | ✅ Runs | ✅ Auto-deploys to **UAT** AWS (when configured) |
| `main` | ✅ Runs | ✅ Auto-deploys to **Production** AWS |

CI workflow: `.github/workflows/ci.yml`  
Deploy workflows: `.github/workflows/deploy-{dev,uat,prod}.yml`

---

## Promoting code through environments

### Dev (continuous integration)

Every merge to `develop` deploys automatically to the Dev environment. Developers verify features here before UAT.

```bash
# After your PR merges — no action needed
# GitHub Actions builds images tagged dev-<sha7> and deploys CDK stacks
```

### UAT (release candidate)

When a sprint milestone or feature set is ready for stakeholder testing:

1. Open a PR: **`develop` → `uat`**
2. Title example: `Release candidate: Sprint 1 — Foundation & Search`
3. After merge, UAT deploys automatically
4. QA and product sign off on UAT

### Production

When UAT is approved:

1. Open a PR: **`uat` → `main`** (or `develop` → `main` if UAT is not yet live — coordinate with the team)
2. Require explicit approval from the release owner
3. Merge triggers production deploy
4. Tag the release (see below)

```bash
# Optional: manual deploy trigger from GitHub Actions UI (workflow_dispatch)
```

---

## Hotfixes (production emergencies)

For critical bugs in production that cannot wait for the normal promotion cycle:

```bash
git checkout main
git pull origin main
git checkout -b hotfix/credit-deduction-race

# fix, test, commit
git push -u origin hotfix/credit-deduction-race
```

1. Open PR: **`hotfix/*` → `main`** — merge after expedited review
2. Production deploys on merge to `main`
3. **Backport** the fix to `develop` (and `uat` if it exists):

```bash
git checkout develop
git pull origin develop
git cherry-pick <hotfix-commit-sha>
git push origin develop
```

---

## Naming releases

Skout follows **[Semantic Versioning 2.0.0](https://semver.org/)** (`MAJOR.MINOR.PATCH`).

| Bump | When | Example |
|------|------|---------|
| **MAJOR** | Breaking API or schema changes | `1.0.0` → `2.0.0` |
| **MINOR** | New features, backward compatible | `0.1.0` → `0.2.0` |
| **PATCH** | Bug fixes, no new features | `0.2.0` → `0.2.1` |

Current package version (reference only): `0.1.0` in root `package.json`. Bump this when cutting a release.

### Git tags (production releases)

Tag **`main`** after each production deployment that represents a named release:

```bash
git checkout main
git pull origin main
git tag -a v0.2.0 -m "Sprint 1 — Foundation & Search (JWT auth, list CRUD, OpenSearch)"
git push origin v0.2.0
```

**Tag format:** `v<MAJOR>.<MINOR>.<PATCH>`

| Tag | Meaning |
|-----|---------|
| `v0.1.0` | MVP initial deploy |
| `v0.2.0` | Sprint 1 complete |
| `v1.0.0` | First public / paid beta launch |

Create tags from GitHub Releases UI for changelog notes, or via CLI as above.

### Docker / ECR image tags (automatic)

Deploy workflows tag container images independently of Git semver. You do not set these manually.

| Environment | Image tag pattern | Example |
|-------------|-------------------|---------|
| Dev | `dev-<git-sha-7>` | `dev-edeb0e9` |
| Prod | `prod-<git-sha-7>` | `prod-a1b2c3d` |
| Latest | `latest` | Always points to most recent deploy per repo |

These tags are traceable to exact commits. For production incidents, find the commit from the image tag:

```bash
git log --oneline | grep a1b2c3d
```

### GitHub Release titles (recommended)

When publishing a GitHub Release from a tag, use a human-readable title:

```
v0.2.0 — Sprint 1: Foundation & Search
```

Include in the release body:

- Sprint or milestone name
- ClickUp tasks completed
- Migration notes (if any)
- Known issues / rollback steps

### Pre-release / beta tags (optional)

For UAT or internal betas before a semver bump on `main`:

| Tag | Use |
|-----|-----|
| `v0.2.0-rc.1` | First release candidate on UAT |
| `v0.2.0-beta.1` | Private beta |

---

## Quick reference

### Daily developer flow

```bash
git checkout develop && git pull
git checkout -b feature/S1-XXX-my-task
# ... work, commit, push ...
# Open PR → develop → squash merge
# Verify on Dev environment after deploy
```

### Release flow

```bash
# 1. develop → uat (PR, merge)
# 2. QA on UAT
# 3. uat → main (PR, merge, approve)
# 4. Tag on main
git tag -a v0.X.Y -m "Release notes"
git push origin v0.X.Y
```

### Branch protection (recommended GitHub settings)

Configure in **Settings → Branches → Branch protection rules**:

| Branch | Require PR | Require CI | Require review |
|--------|------------|------------|----------------|
| `develop` | ✅ | ✅ | 1 approval |
| `uat` | ✅ | ✅ | 1 approval |
| `main` | ✅ | ✅ | 2 approvals (or tech lead) |

---

## Related docs

- [deployment-environments.md](./deployment-environments.md) — branch → AWS environment mapping
- [infra/README.md](../infra/README.md) — CDK deploy commands
- [README.md](../README.md) — local setup and deploy overview
