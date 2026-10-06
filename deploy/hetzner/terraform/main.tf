locals {
  app_host = "stg.${var.base_domain}"
  prefix   = "skout-${var.environment}"
}

module "compute" {
  source         = "./modules/compute"
  name           = local.prefix
  ssh_public_key = var.ssh_public_key
  admin_cidrs    = var.admin_cidrs
  server_type    = var.server_type
  server_count   = var.server_count
  location       = var.location
  network_zone   = var.network_zone
}

# ---------- Postgres (managed, PITR) ----------
resource "digitalocean_database_cluster" "pg" {
  name       = "${local.prefix}-pg"
  engine     = "pg"
  version    = "16"
  size       = var.pg_size
  region     = var.pg_region
  node_count = 1
}

resource "digitalocean_database_db" "app" {
  for_each   = toset(["skout", "email_intelligence", "email_warmup"])
  cluster_id = digitalocean_database_cluster.pg.id
  name       = each.key
}

resource "digitalocean_database_user" "skout" {
  cluster_id = digitalocean_database_cluster.pg.id
  name       = "skout"
}

resource "digitalocean_database_firewall" "pg" {
  cluster_id = digitalocean_database_cluster.pg.id

  dynamic "rule" {
    for_each = module.compute.public_ips
    content {
      type  = "ip_addr"
      value = rule.value
    }
  }
}

# ---------- Object storage (R2) ----------
resource "cloudflare_r2_bucket" "bucket" {
  for_each   = toset(["exports", "scrape", "email-intel"])
  account_id = var.cloudflare_account_id
  name       = "${local.prefix}-${each.key}"
  location   = var.r2_location
}

# ---------- Cloudflare Tunnel + DNS ----------
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "stack" {
  account_id = var.cloudflare_account_id
  name       = "${local.prefix}-tunnel"
  secret     = random_id.tunnel_secret.b64_std
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "stack" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.stack.id

  config {
    ingress_rule {
      hostname = local.app_host
      service  = "http://caddy:80"
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

resource "cloudflare_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = "stg"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.stack.id}.cfargotunnel.com"
  proxied = true
}

# ---------- Auth rate limits (replaces SkoutAuthWaf; Pro plan allows 2 rules, 1-minute windows) ----------
resource "cloudflare_ruleset" "auth_rate_limits" {
  zone_id = var.cloudflare_zone_id
  name    = "${local.prefix}-auth-rate-limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    action      = "block"
    description = "Credential endpoints: login, social login, signup, recovery, OTP"
    enabled     = true
    expression  = "(http.host eq \"${local.app_host}\" and (http.request.uri.path contains \"/auth/login\" or http.request.uri.path contains \"/auth/google\" or http.request.uri.path contains \"/auth/microsoft\" or http.request.uri.path contains \"/auth/signup\" or http.request.uri.path contains \"/auth/password\" or http.request.uri.path contains \"/auth/otp\" or http.request.uri.path contains \"/auth/verify-email\"))"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 10
      mitigation_timeout  = 600
    }
  }

  rules {
    action      = "block"
    description = "All other auth routes"
    enabled     = true
    expression  = "(http.host eq \"${local.app_host}\" and (http.request.uri.path contains \"/api/v1/auth/\" or http.request.uri.path contains \"/app/api/auth/\"))"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 60
      mitigation_timeout  = 600
    }
  }
}
