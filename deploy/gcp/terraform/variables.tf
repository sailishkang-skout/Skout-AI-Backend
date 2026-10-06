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

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "base_domain" {
  type        = string
  description = "Zone apex, e.g. skoutai.io. The app is served at stg.<base_domain>."
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

variable "server_count" {
  type        = number
  default     = 1
  description = "Free-trial accounts cannot raise quotas (about 8 vCPUs), so staging runs on one node."
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

variable "r2_location" {
  type    = string
  default = "ENAM"
}
