output "public_ips" { value = module.compute.public_ips }
output "private_ips" { value = module.compute.private_ips }
output "app_host" { value = local.app_host }
output "ssh_user" { value = var.ssh_user }

# The one DNS record to add at BigRock before the first deploy (Caddy needs it to get a certificate).
output "dns_record_to_add" {
  value = "A  ${local.app_host}  ->  ${module.compute.public_ips[0]}"
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

# S3-compatible access to the buckets: endpoint + HMAC key pair.
output "storage_endpoint" { value = "https://storage.googleapis.com" }
output "storage_buckets" { value = { for k, b in google_storage_bucket.bucket : k => b.name } }
output "storage_access_key_id" { value = google_storage_hmac_key.app.access_id }

output "storage_secret_access_key" {
  value     = google_storage_hmac_key.app.secret
  sensitive = true
}
