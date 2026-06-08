# Skout AI — Infrastructure (AWS CDK)

AWS CDK v2 TypeScript for **local**, **dev**, and **prod** environments.

## Environments

| Environment | Deploy target | Command |
|-------------|---------------|---------|
| **local** | Docker Compose (no AWS) | `pnpm local:env` + docker compose |
| **dev** | AWS (smaller instances) | `pnpm deploy:dev` |
| **prod** | AWS (HA, deletion protection) | `pnpm deploy:prod` |

## Architecture (dev / prod)

```
Internet → ALB → ECS Fargate (web, api)
                      ↓
                 Cloud Map → ECS (ai, internal)
                      ↓
              RDS PostgreSQL + ElastiCache Redis + S3
```

**Stacks per environment:**
1. `Skout{Env}-Network` — VPC, subnets, NAT
2. `Skout{Env}-Data` — RDS, Redis, S3 exports bucket
3. `Skout{Env}-Registry` — ECR repos + GitHub OIDC deploy role
4. `Skout{Env}-Compute` — ECS cluster, ALB, API / AI / Web services

**Local** synthesizes only `SkoutLocal-Config` (reference outputs, no AWS resources).

## Prerequisites

- Node.js 20+, pnpm 9+
- AWS CLI configured (`aws configure`)
- CDK bootstrap (once per account/region):

```bash
cd infra
pnpm install
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

## Local development

```bash
# From repo root
docker compose up -d                          # Postgres + Redis
pnpm --filter @skout/infra local:env          # Generate .env.local.generated

# API + AI in Docker
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build

# Frontend (separate repo — Skout Ai Frontend)
cd ../Skout\ Ai\ Frontend
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

## Deploy dev

```bash
cd infra
pnpm install

# First time: deploy infrastructure (creates ECR, VPC, etc.)
pnpm deploy:dev

# Create secrets manually (once per env):
aws secretsmanager create-secret --name SkoutDev/openai --secret-string '{"OPENAI_API_KEY":"sk-..."}'
```

## Deploy prod

```bash
cd infra
pnpm deploy:prod   # Requires manual approval in CDK for destructive changes

aws secretsmanager create-secret --name SkoutProd/openai --secret-string '{"OPENAI_API_KEY":"sk-..."}'
```

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| `ci.yml` | PR + push to `development`, `uat`, `main` | Test, build, Docker build, CDK synth |
| `deploy-dev.yml` | Push to **`development`** | Build images → ECR → CDK deploy dev |
| `deploy-uat.yml` | Push to **`uat`** | Placeholder until UAT stack exists |
| `deploy-prod.yml` | Push to **`main`** | Build images → ECR → CDK deploy prod |

See [deployment-environments.md](../docs/deployment-environments.md) for branch → env mapping.

### GitHub setup

1. Create environments: `dev`, `production` (with required reviewers for prod)
2. Add secrets:
   - `AWS_DEPLOY_ROLE_ARN_DEV` — from `SkoutDev-Registry` output `GitHubDeployRoleArn`
   - `AWS_DEPLOY_ROLE_ARN_PROD` — from `SkoutProd-Registry` output
3. Add variables:
   - `DEV_API_URL` — e.g. `http://SkoutDev-alb-xxx.us-east-1.elb.amazonaws.com`
   - `PROD_API_URL` — production ALB URL

## Useful commands

```bash
pnpm synth:local    # Local config only
pnpm synth:dev      # Dev CloudFormation templates
pnpm diff:dev       # Preview infra changes
pnpm destroy:dev    # Tear down dev (careful)
```

## Cost estimate (dev)

| Service | ~Monthly |
|---------|----------|
| RDS db.t4g.micro | $15 |
| ElastiCache t4g.micro | $12 |
| ECS Fargate (3 services) | $30–50 |
| ALB | $20 |
| NAT Gateway | $35 |
| **Total** | **~$110–130** |

Prod is higher (multi-AZ RDS, 2× tasks, 2 NAT gateways).

## Configuration

Edit `lib/config/environments.ts` for instance sizes, scaling, domains.

Optional env vars:
- `AWS_REGION` — default `us-east-1`
- `DEV_DOMAIN_NAME` / `PROD_DOMAIN_NAME` — custom domains (Route53 setup separate)
- `GITHUB_ORG` — for OIDC trust policy
