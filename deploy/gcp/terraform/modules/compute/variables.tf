variable "name" { type = string }
variable "region" { type = string }
variable "zone" { type = string }
variable "ssh_public_key" { type = string }
variable "ssh_user" { type = string }
variable "admin_cidrs" { type = list(string) }
variable "machine_type" { type = string }
variable "server_count" { type = number }
