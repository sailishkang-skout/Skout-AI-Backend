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

# ---------- Cloudflare: tunnel, DNS, rate limits, R2 (shared with the GCP root) ----------
module "edge" {
  source                = "../../modules/edge"
  prefix                = local.prefix
  app_host              = local.app_host
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  r2_location           = var.r2_location
}
