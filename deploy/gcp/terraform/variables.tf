variable "environment" {
  type    = string
  default = "staging"
}

variable "gcp_project" {
  type        = string
  description = "Google Cloud project ID (not the display name)."
}

variable "gcp_region" {
  type    = string
  default = "us-east1"
}

variable "gcp_zone" {
  type    = string
  default = "us-east1-b"
}

variable "base_domain" {
  type        = string
  description = "Domain whose DNS stays where it is (BigRock). The app is served at stg.<base_domain>."
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of the deploy public key (ssh-ed25519 AAAA...)."
}

variable "ssh_user" {
  type        = string
  default     = "deploy"
  description = "Login user created from instance metadata. GCE does not allow root SSH."
}

variable "admin_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to SSH to the nodes."
}

variable "web_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "CIDRs allowed to reach ports 80 and 443 (Caddy terminates TLS on the node)."
}

variable "server_count" {
  type        = number
  default     = 1
  description = "Staging runs on one node by default to keep credit burn low; set 2 for a second node."
}

variable "machine_type" {
  type        = string
  default     = "e2-standard-2"
  description = "2 vCPU / 8 GB. With the outbound workers off, staging uses roughly 4-5 GB. Resize up (stop/start) if it runs short."
}

variable "spot" {
  type        = bool
  default     = true
  description = "Spot VM: typically 60-70% cheaper, but Google can stop it at any time (data stays on disk; restart it with gcloud). Set false before production."
}

variable "running" {
  type        = bool
  default     = true
  description = "Pause switch. false stops the VM and the database so compute stops billing (disks and the static IP still do)."
}

variable "boot_disk_gb" {
  type        = number
  default     = 30
  description = "Boot disk size. Holds the Docker images and the Redis/ClickHouse volumes."
}

variable "db_tier" {
  type        = string
  default     = "db-g1-small"
  description = "Cloud SQL shared-core: 1.7 GB, about half the price of db-custom-1-3840. No SLA, fine for staging. If apps hit 'too many connections', move up to db-custom-1-3840."
}

variable "db_disk_gb" {
  type    = number
  default = 10
}

variable "db_disk_type" {
  type        = string
  default     = "PD_HDD"
  description = "PD_HDD is cheapest; use PD_SSD for production."
}

variable "db_backups" {
  type        = bool
  default     = false
  description = "Automated backups and point-in-time recovery. Off for staging (the data is disposable); turn on for production."
}

variable "storage_location" {
  type    = string
  default = "US-EAST1"
}

variable "schedule_enabled" {
  type        = bool
  default     = true
  description = "Run the VM and the database only during working hours (see schedule_days and the times in schedule.tf). Disks and the static IP still bill while stopped."
}

variable "schedule_days" {
  type        = string
  default     = "1-5"
  description = "Cron day-of-week field for the schedule: \"1-5\" = Monday to Friday, \"*\" = every day."
}
