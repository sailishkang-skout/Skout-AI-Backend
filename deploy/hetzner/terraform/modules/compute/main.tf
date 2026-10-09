terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud" }
  }
}

resource "hcloud_ssh_key" "deploy" {
  name       = "${var.name}-deploy"
  public_key = var.ssh_public_key
}

resource "hcloud_network" "private" {
  name     = "${var.name}-net"
  ip_range = "10.20.0.0/16"
}

resource "hcloud_network_subnet" "private" {
  network_id   = hcloud_network.private.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = "10.20.1.0/24"
}

# No inbound 80/443: public traffic arrives through the Cloudflare Tunnel (outbound connection).
resource "hcloud_firewall" "nodes" {
  name = "${var.name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.admin_cidrs
  }
}

resource "hcloud_server" "node" {
  count        = var.server_count
  name         = "${var.name}-${count.index + 1}"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  user_data    = file("${path.module}/cloud-init.yaml")

  labels = {
    role     = count.index == 0 ? "manager" : "worker"
    stateful = count.index == 0 ? "true" : "false"
  }

  network {
    network_id = hcloud_network.private.id
    ip         = "10.20.1.${10 + count.index}"
  }

  depends_on = [hcloud_network_subnet.private]
}
