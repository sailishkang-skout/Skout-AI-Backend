variable "name" { type = string }
variable "ssh_public_key" { type = string }
variable "admin_cidrs" { type = list(string) }
variable "server_type" { type = string }
variable "server_count" { type = number }

variable "location" {
  type    = string
  default = "ash"
}

variable "network_zone" {
  type    = string
  default = "us-east"
}
