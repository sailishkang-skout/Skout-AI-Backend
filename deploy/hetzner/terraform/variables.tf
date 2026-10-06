variable "environment" {
  type    = string
  default = "staging"
}

variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "base_domain" {
  type        = string
  description = "Staging zone apex, e.g. skout-staging.dev (NOT skoutai.io)."
}

variable "do_token" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" { type = string }

variable "admin_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to SSH to the nodes (your office/VPN IPs, plus the GitHub runner approach in Task 7)."
}

variable "server_count" {
  type    = number
  default = 2
}

variable "server_type" {
  type        = string
  default     = "cpx31"
  description = "4 vCPU / 8 GB. Two nodes give 16 GB total. In EU locations the equivalent type is cpx32."
}

# Region. Defaults are Ashburn + NYC. For the cheaper EU setup use:
#   location = "fsn1", network_zone = "eu-central", pg_region = "fra1", r2_location = "WEUR", server_type = "cpx32"
variable "location" {
  type    = string
  default = "ash"
}

variable "network_zone" {
  type    = string
  default = "us-east"
}

variable "pg_region" {
  type    = string
  default = "nyc3"
}

variable "r2_location" {
  type    = string
  default = "ENAM"
}

variable "pg_size" {
  type    = string
  default = "db-s-1vcpu-2gb"
}
