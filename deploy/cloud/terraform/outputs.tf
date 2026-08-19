output "control_plane_repository_url" {
  value = try(aws_ecr_repository.control_plane[0].repository_url, null)
}

output "worker_repository_url" {
  value = try(aws_ecr_repository.worker[0].repository_url, null)
}

output "ecs_cluster" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service" {
  value = aws_ecs_service.api.name
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs.id
}

output "load_balancer_dns_name" {
  value = aws_lb.this.dns_name
}

output "secret_arns" {
  value     = { for key, secret in aws_secretsmanager_secret.cloud : key => secret.arn }
  sensitive = true
}
