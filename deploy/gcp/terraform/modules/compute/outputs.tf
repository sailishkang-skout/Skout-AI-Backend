output "public_ips" { value = google_compute_address.node[*].address }
output "private_ips" { value = [for i in google_compute_instance.node : i.network_interface[0].network_ip] }
