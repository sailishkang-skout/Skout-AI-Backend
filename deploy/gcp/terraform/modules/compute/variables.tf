variable "name" { type = string }
variable "region" { type = string }
variable "zone" { type = string }
variable "ssh_public_key" { type = string }
variable "ssh_user" { type = string }
variable "admin_cidrs" { type = list(string) }
variable "machine_type" { type = string }
variable "server_count" { type = number }
variable "web_cidrs" { type = list(string) }
variable "spot" { type = bool }
variable "running" { type = bool }
variable "boot_disk_gb" { type = number }
variable "resource_policies" {
  type    = list(string)
  default = []
}
