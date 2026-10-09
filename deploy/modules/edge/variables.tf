variable "prefix" {
  type        = string
  description = "Name prefix, e.g. skout-staging."
}

variable "app_host" {
  type        = string
  description = "Public host name served through the tunnel, e.g. stg.skoutai.io."
}

variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "r2_location" {
  type    = string
  default = "ENAM"
}
