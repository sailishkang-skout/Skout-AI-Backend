# Output names match deploy/hetzner/terraform so the scripts and runbook work with either provider.
output "public_ips" { value = module.compute.public_ips }
output "private_ips" { value = module.compute.private_ips }
output "app_host" { value = local.app_host }
output "ssh_user" { value = var.ssh_user }

output "tunnel_token" {
  value     = module.edge.tunnel_token
  sensitive = true
}

output "pg_host" { value = google_sql_database_instance.pg.public_ip_address }
output "pg_port" { value = 5432 }
output "pg_admin_user" { value = google_sql_user.postgres.name }

output "pg_admin_password" {
  value     = random_password.pg_admin.result
  sensitive = true
}

output "skout_db_password" {
  value     = random_password.skout_db.result
  sensitive = true
}

output "r2_buckets" { value = module.edge.r2_buckets }
