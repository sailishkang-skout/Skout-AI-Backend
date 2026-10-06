terraform {
  required_providers {
    google = { source = "hashicorp/google" }
  }
}

resource "google_compute_network" "vpc" {
  name                    = "${var.name}-net"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "${var.name}-subnet"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = "10.30.0.0/24"
}

# Caddy on the node terminates TLS (Let's Encrypt) and routes by path, so 80 and 443 are open.
resource "google_compute_firewall" "web" {
  name          = "${var.name}-web"
  network       = google_compute_network.vpc.name
  source_ranges = var.web_cidrs
  target_tags   = ["swarm-node"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_firewall" "ssh" {
  name          = "${var.name}-ssh"
  network       = google_compute_network.vpc.name
  source_ranges = var.admin_cidrs
  target_tags   = ["swarm-node"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Swarm control and overlay traffic between the nodes (2377/tcp, 7946/tcp+udp, 4789/udp) stays inside the subnet.
resource "google_compute_firewall" "internal" {
  name          = "${var.name}-internal"
  network       = google_compute_network.vpc.name
  source_ranges = [google_compute_subnetwork.subnet.ip_cidr_range]
  target_tags   = ["swarm-node"]

  allow {
    protocol = "tcp"
  }
  allow {
    protocol = "udp"
  }
  allow {
    protocol = "icmp"
  }
}

# Static addresses: the Cloud SQL allow-list is built from them, and they survive a stop/start.
resource "google_compute_address" "node" {
  count  = var.server_count
  name   = "${var.name}-${count.index + 1}-ip"
  region = var.region
}

resource "google_compute_instance" "node" {
  count        = var.server_count
  name         = "${var.name}-${count.index + 1}"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["swarm-node"]

  labels = {
    role     = count.index == 0 ? "manager" : "worker"
    stateful = count.index == 0 ? "true" : "false"
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 60
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    network_ip = "10.30.0.${10 + count.index}"
    access_config {
      nat_ip = google_compute_address.node[count.index].address
    }
  }

  metadata = {
    ssh-keys               = "${var.ssh_user}:${var.ssh_public_key}"
    block-project-ssh-keys = "true"
  }

  metadata_startup_script   = templatefile("${path.module}/startup.sh", { ssh_user = var.ssh_user })
  allow_stopping_for_update = true
}
