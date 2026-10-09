output "tunnel_token" {
  value     = cloudflare_zero_trust_tunnel_cloudflared.stack.tunnel_token
  sensitive = true
}

output "r2_buckets" { value = { for k, b in cloudflare_r2_bucket.bucket : k => b.name } }
