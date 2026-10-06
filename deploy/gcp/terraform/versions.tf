terraform {
  required_version = ">= 1.6"

  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # State lives in a GCS bucket you create once (see docs/ops/gcp-staging-runbook.md, step 3):
  #   gcloud storage buckets create gs://skoutai-510223-tfstate --location=us-east1 --uniform-bucket-level-access
  backend "gcs" {
    bucket = "skoutai-510223-tfstate"
    prefix = "gcp/staging"
  }
}

# Auth: `gcloud auth application-default login` (or GOOGLE_APPLICATION_CREDENTIALS).
provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
  zone    = var.gcp_zone
}
