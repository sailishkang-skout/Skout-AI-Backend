terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
    random     = { source = "hashicorp/random" }
  }
}

# ---------- Object storage (R2) ----------
resource "cloudflare_r2_bucket" "bucket" {
  for_each   = toset(["exports", "scrape", "email-intel"])
  account_id = var.cloudflare_account_id
  name       = "${var.prefix}-${each.key}"
  location   = var.r2_location
}

# ---------- Cloudflare Tunnel + DNS ----------
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "stack" {
  account_id = var.cloudflare_account_id
  name       = "${var.prefix}-tunnel"
  secret     = random_id.tunnel_secret.b64_std
  # Remote-managed tunnel: cloudflared run with the token takes its ingress from the _config resource
  # below. With the default ("local") it would ignore that config and answer 503. Changing this forces
  # a new tunnel, so it is set before the first apply.
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "stack" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.stack.id

  config {
    ingress_rule {
      hostname = var.app_host
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
  name    = "${var.prefix}-auth-rate-limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    action      = "block"
    description = "Credential endpoints: login, social login, signup, recovery, OTP"
    enabled     = true
    expression  = "(http.host eq \"${var.app_host}\" and (lower(http.request.uri.path) contains \"/auth/login\" or lower(http.request.uri.path) contains \"/auth/google\" or lower(http.request.uri.path) contains \"/auth/microsoft\" or lower(http.request.uri.path) contains \"/auth/signup\" or lower(http.request.uri.path) contains \"/auth/password\" or lower(http.request.uri.path) contains \"/auth/otp\" or lower(http.request.uri.path) contains \"/auth/verify-email\"))"

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
    expression  = "(http.host eq \"${var.app_host}\" and (lower(http.request.uri.path) contains \"/api/v1/auth/\" or lower(http.request.uri.path) contains \"/app/api/auth/\"))"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 60
      mitigation_timeout  = 600
    }
  }
}
