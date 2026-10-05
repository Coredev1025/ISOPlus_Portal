# Production runtime (Elastic Beanstalk, Redis, S3, MongoDB Atlas)

What the running product is made of in AWS, read from the account on 2026-10-06 with read-only calls. Names
only: no account identifiers, no secret values. Anything that could not be read from AWS is marked
**to confirm**. Where backups and recovery are covered, see [`12-backups-and-recovery.md`](12-backups-and-recovery.md); for
DNS and the proxy in front, [`11-dns-and-cloudflare.md`](11-dns-and-cloudflare.md).

## Shape

```
browser -> Cloudflare (DNS, proxy) -> AWS application load balancer -> Elastic Beanstalk instance (Node.js)
                                                                          |-> ElastiCache Serverless (Redis)
                                                                          |-> S3 (documents, public assets)
                                                                          |-> MongoDB Atlas (database)
```

The frontend (`portal.isoplus.online`) is deployed separately from the backend and is not part of the
backend deploy workflow. How it is hosted is **to confirm**. The backend is `portal-backend.isoplus.online`.

## Elastic Beanstalk

| | Production | Dev |
|---|---|---|
| Application | `isoplus-be-prod` | `isoplus-be-dev` |
| Live environment | `isoplus-be-prod-blue` | `isoplus-be-dev-blue` |
| Idle twin | `isoplus-be-prod-green` | `isoplus-be-dev-green` |
| Platform | Node.js 22 on 64-bit Amazon Linux 2023, v6.5.1 | the same |
| Type | Load balanced, application load balancer, internet-facing | the same |
| Capacity | 1 instance (minimum 1, maximum 1), types `t3.medium` and `t3.small` | the same |
| Load balancer idle timeout | 180 seconds (long sync and PDF requests) | **to confirm** |
| Instance role | `isoplus-be-prod-ec2-role` | `isoplus-be-dev-ec2-role` |
| Log streaming to CloudWatch | On, kept 7 days, kept after the environment is terminated | Off |

Deploys: a push to `main` (production) or `develop` (dev) that changes `Backend/**` deploys to the `-blue`
environment, via the deploy bucket. See [`../release-runbook.md`](../release-runbook.md).

**One instance means no redundancy.** A deploy or an instance replacement is a short outage, and there is
no second instance to take traffic. This is how production is today, not a recommendation.

**The `-green` environments are empty.** No instances, health Grey, still on a sample version (`v1-...`).
They are left over from an earlier blue/green setup. Each has its own load balancer, and four load balancers
exist for four environments, so two are idle. Whether they can be removed is **to confirm** (nothing here
changes them).

Environment properties: see [`09-production-environment-properties.md`](09-production-environment-properties.md).
Never read an environment's configuration page or `describe-configuration-settings` without a filter:
it prints every value, including secrets.

## Redis (ElastiCache Serverless)

| | Production | Dev |
|---|---|---|
| Cache | `isoplus-portal-prod-redis` | `isoplus-portal-dev-redis` |
| Engine | Redis 7, serverless, cluster mode (`REDIS_CLUSTER=true`) | the same |
| Connection | TLS (`REDIS_TLS`), host and port as environment properties | host and port as properties |
| Daily snapshot | 18:30 UTC, kept 1 day | none |

Redis holds the BullMQ queues (board sync, the invoice and statement automation). The data is working state,
not the record of anything: invoices, documents and settings live in MongoDB and S3.

## S3

| Bucket | Used for | Settings read 2026-10-06 |
|---|---|---|
| `isoplus-portal` | Production documents (invoices, statements, uploads) | Private (all four public-access blocks on), encrypted (AES-256), **no versioning**, no lifecycle rules |
| `isoplus-portal-public` | Production public assets | Public-access blocks **off**, encrypted (AES-256), no versioning. What is meant to be public in it is **to confirm** |
| `isoplus-portal-dev`, `isoplus-portal-dev-public` | The same for dev | not read |
| `isoplus-be-prod-deploy-bucket-isoplus-be-prod`, `isoplus-be-dev-deploy-bucket-isoplus-be-dev`, `isoplus-backend-deploy-bucket-isoplus-v1` | Deployment packages | not read; the workflow uploads to the last one |
| `isoplus-email-logs` | Email logs (purpose **to confirm**) | Private, encrypted, no lifecycle |
| `isoplus-db-backups-...` | Production MongoDB backups | see [`12-backups-and-recovery.md`](12-backups-and-recovery.md) |

The application reaches S3 with an IAM user key set as plain text properties
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). Replacing that with the instance role is KAN-325.

## MongoDB Atlas

The database is MongoDB Atlas, outside AWS. Production uses the `cluster0` cluster and dev the `cluster1` cluster (both database `iso-plus`). Nothing about the production cluster (tier, region, network
access, who holds the Atlas account, whether Atlas backups are on) could be read from AWS. The application
connects with `MONGODB_URI`, a plain text environment property. **All of this is to confirm** with whoever
owns the Atlas account, and should be written into this section.

## Known mismatches with the Terraform example

`infrastructure/terraform/prod.tfvars.example` was written before this was read, and differs from reality:

| In the example | Reality |
|---|---|
| `app_s3_buckets`: `isoplus-portal-prod`, `isoplus-portal-prod-public` | `isoplus-portal`, `isoplus-portal-public` |
| `scheduler_endpoint`: host `portal-be.isoplus.online` | `portal-backend.isoplus.online` (the other does not exist) |

Fix both in the Terraform change before anything is applied.
