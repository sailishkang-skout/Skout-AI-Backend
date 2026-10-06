# Hetzner Terraform root: not maintained against the current stack

This root was written for a Cloudflare Tunnel front door. The Swarm stack now serves HTTPS directly from Caddy
(see `docs/ops/gcp-staging-runbook.md`), so using this root would need porting first:

- open ports 80/443 in the Hetzner firewall and drop the tunnel and rate-limit resources,
- point a DNS A record at the node (the DNS host does not have to be Cloudflare),
- keep R2 or another S3-compatible store for the buckets.

The GCP root in `deploy/gcp/terraform` is the maintained option. The shared Cloudflare module in `deploy/modules/edge` is kept for a future Cloudflare-fronted deployment.
