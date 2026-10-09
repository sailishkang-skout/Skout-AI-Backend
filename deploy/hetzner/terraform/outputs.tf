output "public_ips" { value = module.compute.public_ips }
output "private_ips" { value = module.compute.private_ips }
output "app_host" { value = local.app_host }

output "tunnel_token" {
  value     = module.edge.tunnel_token
  sensitive = true
}

output "pg_host" { value = digitalocean_database_cluster.pg.host }
output "pg_port" { value = digitalocean_database_cluster.pg.port }

output "pg_admin_user" { value = digitalocean_database_cluster.pg.user }

output "pg_admin_password" {
  value     = digitalocean_database_cluster.pg.password
  sensitive = true
}

output "skout_db_password" {
  value     = digitalocean_database_user.skout.password
  sensitive = true
}

output "r2_buckets" { value = module.edge.r2_buckets }
