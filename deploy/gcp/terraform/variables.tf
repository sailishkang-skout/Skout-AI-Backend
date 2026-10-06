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
  default     = "e2-standard-4"
  description = "4 vCPU / 16 GB. The whole fleet's memory limits sum to about 10 GB."
}

variable "db_tier" {
  type        = string
  default     = "db-custom-1-3840"
  description = "Cloud SQL: 1 vCPU / 3.75 GB."
}

variable "storage_location" {
  type    = string
  default = "US-EAST1"
}
