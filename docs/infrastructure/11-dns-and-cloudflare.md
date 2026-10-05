# DNS and Cloudflare

Who controls `isoplus.online`, where its records live, and what the stage 2 email work will need to add. Read on
2026-10-06 from public DNS and the AWS account. Record values are not copied here; names and purposes are.

## Who holds what

| Item | Where |
|---|---|
| Registrar | Dreamscape Networks. Registered until 6 June 2028 |
| DNS | **Cloudflare** (the domain's name servers are Cloudflare's). **Not** AWS Route 53: this account's hosted zones are `cbisco.*` and `isoconsultingservices.*`, none for `isoplus.online` |
| Who has the Cloudflare account | **To confirm**, and who may add records |
| TLS certificate on the AWS load balancer | ACM, `*.isoplus.online`, issued, in `ap-southeast-2` |

Because the DNS is not in Route 53, the Terraform keeps `manage_dns = false` and the SES verification records
are added by hand in Cloudflare.

## Hosts

| Host | Purpose | Resolves to |
|---|---|---|
| `portal.isoplus.online` | Production frontend | Cloudflare addresses |
| `portal-backend.isoplus.online` | Production backend (also the Google callback and the scheduler tick) | Cloudflare addresses |
| `portal-dev.isoplus.online` | Dev frontend | Cloudflare addresses |
| `portal-be-dev.isoplus.online` | Dev backend | Cloudflare addresses |
| `mail.isoplus.online`, `dev.isoplus.online` | Planned SES sending subdomains | **No records yet** |

All four portal hosts answer with Cloudflare addresses, so they are **proxied** (orange cloud): browsers talk
to Cloudflare, and Cloudflare talks to the AWS load balancer. The origin each record points at is **to
confirm** in Cloudflare.

Two consequences to check:

* **Request time limit.** Cloudflare gives up on a proxied request after about 100 seconds on most plans,
  while the load balancer and nginx are tuned for up to 180 seconds for long sync and PDF requests. Anything
  between 100 and 180 seconds can fail at Cloudflare first. Which plan production is on is **to confirm**.
* **Scheduler.** EventBridge will call `portal-backend` through Cloudflare every minute. If Cloudflare
  challenges or rate-limits that traffic, no schedule runs. Allow it by the `Authorization` header or a
  WAF skip rule, **to confirm** when stage 2 is built.

## Email records already on the domain

| Record | Value in words |
|---|---|
| MX | Google Workspace (`aspmx.l.google.com` and the alternates). Staff email, unrelated to the portal |
| TXT at the apex | Two Google site-verification records. **No SPF record was returned** at the apex |
| `_dmarc` | Policy `none` (monitor only), reports to a Cloudflare DMARC address |

## What stage 2 (SES) will add in Cloudflare

For the production sending identity (`isoplus.online`, MAIL FROM `mail.isoplus.online`), once the Terraform
creates it. The exact values come from the SES console or the Terraform outputs, not from this file.

* Three DKIM CNAME records for the domain. Set them **DNS only** (grey cloud), not proxied.
* On `mail.isoplus.online`: an MX record to SES and an SPF TXT record, for the custom MAIL FROM domain.
* The apex has no SPF today. Adding one affects staff email through Google Workspace; coordinate it, do not
  just append. DMARC at `none` does not block anything, but SPF and DKIM alignment still decide whether
  invoices reach the inbox.
* After verification, move DMARC from `none` toward `quarantine` only when reports show nothing legitimate is
  failing. A separate decision.

Dev's sending domain is `dev.isoplus.online`, with its records built by hand earlier.

## Changing a host

Adding or repointing a portal host (for example a new backend) is a change to production traffic: do it in
Cloudflare, keep the old record until the new one is verified, and update `BACKEND_URL`, the Google redirect
URI and `ALLOWED_ORIGINS` together. They must all agree.
