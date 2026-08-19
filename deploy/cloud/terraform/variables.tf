variable "aws_region" {
  description = "AWS region for the control plane."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "AO hosted environment."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "public_hostname" {
  description = "Public HTTPS origin used by Electron clients and sandbox workers."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted-zone ID for public_hostname. Leave empty to manage DNS elsewhere."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate ARN covering public_hostname."
  type        = string
}

variable "alert_topic_arn" {
  description = "Optional SNS topic receiving alarm state changes."
  type        = string
  default     = ""
}

variable "database_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "database_name" {
  type    = string
  default = "ao_cloud"
}

variable "database_owner_user" {
  type    = string
  default = "ao_cloud_owner"
}

variable "database_runtime_user" {
  type    = string
  default = "ao_cloud_app"
}

variable "database_deletion_protection" {
  type    = bool
  default = true
}

variable "google_client_ids" {
  description = "Comma-separated Google OAuth client IDs accepted by the token exchange."
  type        = string
  sensitive   = true
}

variable "daytona_api_url" {
  type    = string
  default = "https://app.daytona.io/api"
}

variable "daytona_api_key" {
  type      = string
  sensitive = true
}

variable "daytona_target" {
  type    = string
  default = ""
}

variable "daytona_snapshot" {
  description = "Pinned Daytona snapshot containing Claude Code and the unprivileged ao-worker user."
  type        = string
}

variable "daytona_user" {
  type    = string
  default = "root"
}

variable "daytona_domain_allow_list" {
  description = "Comma-separated egress domains needed by AO, Anthropic, GitHub, and package tooling."
  type        = string
}

variable "repository_broker_url" {
  description = "Production control-plane origin used by staging for repository-scoped grants."
  type        = string
  default     = "https://api.aoagents.dev"
}

variable "repository_broker_token" {
  description = "Shared high-entropy token used only between staging and production control planes."
  type        = string
  sensitive   = true
}

variable "environment_control_token" {
  description = "High-entropy token authorizing production to create staging scratch repositories."
  type        = string
  sensitive   = true
}

variable "github_app_id" {
  description = "Production GitHub App numeric ID. Leave empty in staging."
  type        = string
  default     = ""
}

variable "github_app_slug" {
  type    = string
  default = ""
}

variable "github_client_id" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_private_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_webhook_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "control_plane_image" {
  description = "Bootstrap task image. The release script replaces it with a digest-pinned AO image."
  type        = string
  default     = "public.ecr.aws/docker/library/busybox:1.36"
}

variable "manage_ecr_repositories" {
  description = "Create the account-shared ECR repositories. Enable for staging only."
  type        = bool
  default     = true
}

variable "deployment_enabled" {
  description = "Enable the post-bootstrap autoscaling floor after the first successful release."
  type        = bool
  default     = false
}

variable "api_cpu" {
  type    = number
  default = 1024
}

variable "api_memory" {
  type    = number
  default = 2048
}
