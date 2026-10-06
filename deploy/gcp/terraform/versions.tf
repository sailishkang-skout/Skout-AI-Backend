terraform {
  required_version = ">= 1.6"

  required_providers {
    google     = { source = "hashicorp/google", version = "~> 6.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.40" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # State lives in Cloudflare R2 (S3-compatible), in the same bucket as the Hetzner root but its own key:
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    bucket                      = "skout-tfstate"
    key                         = "gcp/staging.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Auth: `gcloud auth application-default login` (or GOOGLE_APPLICATION_CREDENTIALS).
provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
  zone    = var.gcp_zone
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
