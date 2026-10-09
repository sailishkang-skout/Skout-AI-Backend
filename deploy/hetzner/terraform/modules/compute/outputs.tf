output "public_ips" { value = hcloud_server.node[*].ipv4_address }
output "private_ips" { value = [for s in hcloud_server.node : one(s.network).ip] }
