terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud       = { source = "hetznercloud/hcloud", version = "~> 1.48" }
    cloudflare   = { source = "cloudflare/cloudflare", version = "~> 4.40" }
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.43" }
    random       = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # State lives in Cloudflare R2 (S3-compatible). Endpoint and keys are passed at init:
  #   terraform init -backend-config="endpoints={s3=\"$R2_ENDPOINT\"}" \
  #     -backend-config="access_key=$R2_ACCESS_KEY_ID" -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
  backend "s3" {
    bucket                      = "skout-tfstate"
    key                         = "hetzner/staging.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "digitalocean" {
  token = var.do_token
}
