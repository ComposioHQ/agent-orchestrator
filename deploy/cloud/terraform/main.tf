data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  name               = "ao-cloud-${var.environment}"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  public_url         = "https://${var.public_hostname}"
  secret_prefix      = "ao-cloud/${var.environment}"
  alarm_actions      = var.alert_topic_arn == "" ? [] : [var.alert_topic_arn]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  tags              = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]
  tags          = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS ingress"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs" {
  name        = "${local.name}-ecs"
  description = "Control-plane tasks"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL from control-plane tasks only"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }
}

resource "aws_kms_key" "cloud" {
  description             = "AO Cloud ${var.environment} data and secret encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ao-cloud/${var.environment}/control-plane"]
    }
  }
}

resource "aws_kms_alias" "cloud" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.cloud.key_id
}

resource "random_password" "database_owner" {
  length  = 40
  special = false
}

resource "random_password" "database_runtime" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "this" {
  identifier                   = "${local.name}-storage"
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = var.database_instance_class
  allocated_storage            = 20
  max_allocated_storage        = 100
  storage_type                 = "gp3"
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.cloud.arn
  db_name                      = var.database_name
  username                     = var.database_owner_user
  password                     = random_password.database_owner.result
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  publicly_accessible          = false
  backup_retention_period      = var.environment == "production" ? 14 : 7
  deletion_protection          = var.database_deletion_protection
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-final"
  auto_minor_version_upgrade   = true
  performance_insights_enabled = true
}

resource "random_id" "provider_key" {
  byte_length = 32
}

resource "random_id" "auth_key" {
  byte_length = 32
}

resource "random_password" "worker_key" {
  length  = 64
  special = false
}

resource "random_id" "github_state_key" {
  byte_length = 32
}

locals {
  database_owner_url   = "postgres://${var.database_owner_user}:${urlencode(random_password.database_owner.result)}@${aws_db_instance.this.address}:5432/${var.database_name}?sslmode=require"
  database_runtime_url = "postgres://${var.database_runtime_user}:${urlencode(random_password.database_runtime.result)}@${aws_db_instance.this.address}:5432/${var.database_name}?sslmode=require"
  secret_values = {
    database-url           = local.database_runtime_url
    migration-database-url = local.database_owner_url
    provider-secret-key    = random_id.provider_key.b64_std
    daytona = jsonencode({
      api_url           = var.daytona_api_url
      api_key           = var.daytona_api_key
      target            = var.daytona_target
      snapshot          = var.daytona_snapshot
      user              = var.daytona_user
      domain_allow_list = var.daytona_domain_allow_list
      worker_token_ttl  = "15m"
    })
    auth = jsonencode({
      google_client_ids = var.google_client_ids
      signing_key       = random_id.auth_key.b64_std
    })
    worker = jsonencode({
      signing_key                  = random_password.worker_key.result
      max_active_sandboxes_per_org = "10"
      sandbox_reconcile_interval   = "2s"
      sandbox_startup_timeout      = "3m"
      worker_heartbeat_timeout     = "1m"
    })
    repository-broker = jsonencode({
      auth_token            = var.repository_broker_token
      staging_control_token = var.environment_control_token
    })
    database-runtime = jsonencode({
      username = var.database_runtime_user
      password = random_password.database_runtime.result
    })
    github = jsonencode({
      app_id         = var.github_app_id
      app_slug       = var.github_app_slug
      client_id      = var.github_client_id
      client_secret  = var.github_client_secret
      private_key    = var.github_private_key
      webhook_secret = var.github_webhook_secret
      state_key      = random_id.github_state_key.b64_std
    })
  }
}

resource "aws_secretsmanager_secret" "cloud" {
  for_each   = local.secret_values
  name       = "${local.secret_prefix}/${each.key}"
  kms_key_id = aws_kms_key.cloud.arn
}

resource "aws_secretsmanager_secret_version" "cloud" {
  for_each      = local.secret_values
  secret_id     = aws_secretsmanager_secret.cloud[each.key].id
  secret_string = each.value
}

resource "aws_ecr_repository" "control_plane" {
  count                = var.manage_ecr_repositories ? 1 : 0
  name                 = "ao-cloud-control-plane"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.cloud.arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "worker" {
  count                = var.manage_ecr_repositories ? 1 : 0
  name                 = "ao-cloud-worker"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.cloud.arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/ao-cloud/${var.environment}/control-plane"
  retention_in_days = var.environment == "production" ? 90 : 30
  kms_key_id        = aws_kms_key.cloud.arn
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(aws_secretsmanager_secret.cloud)[*].arn
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.cloud.arn]
  }
}

resource "aws_iam_role_policy" "secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

locals {
  api_environment = [
    { name = "AO_CLOUD_ENV", value = var.environment },
    { name = "AO_CLOUD_HTTP_ADDRESS", value = ":8080" },
    { name = "AO_CLOUD_PUBLIC_URL", value = local.public_url },
    { name = "AO_CLOUD_RELEASE", value = "bootstrap" },
    { name = "AO_CLOUD_LOCAL_AUTH", value = "false" },
    { name = "AO_CLOUD_MIGRATE_ON_STARTUP", value = "false" },
    { name = "AO_CLOUD_SANDBOX_PROVIDER", value = "daytona" },
    { name = "AO_CLOUD_WORKER_BINARY_PATH", value = "/ao-worker" },
    { name = "AO_CLOUD_WORKER_HELPER_BINARY_PATH", value = "/ao" },
    { name = "AO_CLOUD_REPOSITORY_BROKER_URL", value = var.repository_broker_url },
  ]
  api_secrets = concat([
    { name = "AO_CLOUD_DATABASE_URL", valueFrom = aws_secretsmanager_secret.cloud["database-url"].arn },
    { name = "AO_CLOUD_PROVIDER_SECRET_KEY", valueFrom = aws_secretsmanager_secret.cloud["provider-secret-key"].arn },
    ], [for env_name, key in {
      AO_CLOUD_DAYTONA_API_URL              = "api_url"
      AO_CLOUD_DAYTONA_API_KEY              = "api_key"
      AO_CLOUD_DAYTONA_TARGET               = "target"
      AO_CLOUD_DAYTONA_SNAPSHOT             = "snapshot"
      AO_CLOUD_DAYTONA_USER                 = "user"
      AO_CLOUD_DAYTONA_DOMAIN_ALLOW_LIST    = "domain_allow_list"
      AO_CLOUD_DAYTONA_WORKER_TOKEN_TTL     = "worker_token_ttl"
      } : { name                            = env_name, valueFrom = "${aws_secretsmanager_secret.cloud["daytona"].arn}:${key}::" }], [for env_name, key in {
      AO_CLOUD_GOOGLE_CLIENT_IDS            = "google_client_ids"
      AO_CLOUD_AUTH_SIGNING_KEY             = "signing_key"
      } : { name                            = env_name, valueFrom = "${aws_secretsmanager_secret.cloud["auth"].arn}:${key}::" }], [for env_name, key in {
      AO_CLOUD_WORKER_SIGNING_KEY           = "signing_key"
      AO_CLOUD_MAX_ACTIVE_SANDBOXES_PER_ORG = "max_active_sandboxes_per_org"
      AO_CLOUD_SANDBOX_RECONCILE_INTERVAL   = "sandbox_reconcile_interval"
      AO_CLOUD_SANDBOX_STARTUP_TIMEOUT      = "sandbox_startup_timeout"
      AO_CLOUD_WORKER_HEARTBEAT_TIMEOUT     = "worker_heartbeat_timeout"
    } : { name = env_name, valueFrom = "${aws_secretsmanager_secret.cloud["worker"].arn}:${key}::" }], [
    { name = "AO_CLOUD_REPOSITORY_BROKER_TOKEN", valueFrom = "${aws_secretsmanager_secret.cloud["repository-broker"].arn}:auth_token::" },
    { name = "AO_CLOUD_ENV_CONTROL_TOKEN", valueFrom = "${aws_secretsmanager_secret.cloud["repository-broker"].arn}:staging_control_token::" },
    ], var.environment == "production" ? [for env_name, key in {
      AO_CLOUD_GITHUB_APP_ID         = "app_id"
      AO_CLOUD_GITHUB_APP_SLUG       = "app_slug"
      AO_CLOUD_GITHUB_CLIENT_ID      = "client_id"
      AO_CLOUD_GITHUB_CLIENT_SECRET  = "client_secret"
      AO_CLOUD_GITHUB_PRIVATE_KEY    = "private_key"
      AO_CLOUD_GITHUB_WEBHOOK_SECRET = "webhook_secret"
      AO_CLOUD_GITHUB_STATE_KEY      = "state_key"
  } : { name = env_name, valueFrom = "${aws_secretsmanager_secret.cloud["github"].arn}:${key}::" }] : [])
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "control-plane"
    image        = var.control_plane_image
    essential    = true
    environment  = local.api_environment
    secrets      = local.api_secrets
    portMappings = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD", "/ao-cloud-healthcheck"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.control_plane.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }])

  lifecycle {
    precondition {
      condition = var.environment != "production" || alltrue([
        var.github_app_id != "",
        var.github_app_slug != "",
        var.github_client_id != "",
        var.github_client_secret != "",
        var.github_private_key != "",
        var.github_webhook_secret != "",
      ])
      error_message = "production requires a complete GitHub App configuration"
    }
  }
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name       = "migration"
    image      = var.control_plane_image
    essential  = true
    entryPoint = ["/ao-cloud-migrate"]
    environment = [
      { name = "AO_CLOUD_RELEASE", value = "bootstrap" },
      { name = "AO_CLOUD_RUNTIME_DATABASE_USER", value = var.database_runtime_user },
    ]
    secrets = [
      { name = "AO_CLOUD_MIGRATION_DATABASE_URL", valueFrom = aws_secretsmanager_secret.cloud["migration-database-url"].arn },
      { name = "AO_CLOUD_RUNTIME_DATABASE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.cloud["database-runtime"].arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.control_plane.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
}

resource "aws_lb" "this" {
  name                       = substr(local.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = var.environment == "production"
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${local.name}-api", 0, 32)
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30
  health_check {
    path                = "/readyz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.public_hostname
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_service" "api" {
  name                              = "${local.name}-api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = 0
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 60
  enable_execute_command            = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "control-plane"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener.https]
  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

resource "aws_appautoscaling_target" "api" {
  count              = var.deployment_enabled ? 1 : 0
  max_capacity       = 6
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.deployment_enabled ? 1 : 0
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.api[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.api[0].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${local.name}-target-5xx"
  alarm_description   = "Sustained AO Cloud target 5xx responses"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}
