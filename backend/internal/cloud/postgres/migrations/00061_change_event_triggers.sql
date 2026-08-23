-- +goose Up
-- Explicit PostgreSQL counterparts of the accepted SQLite change_log trigger
-- contract. Migration ordering guarantees every referenced product table was
-- created before this migration; a renamed or missing table must fail loudly.

CREATE TRIGGER ao_sessions_change_created
AFTER INSERT ON ao_sessions
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'session_created', 'project_id', 'id', 'session');

CREATE TRIGGER ao_sessions_change_updated
AFTER UPDATE ON ao_sessions
FOR EACH ROW
WHEN (
    OLD.activity_state IS DISTINCT FROM NEW.activity_state OR
    OLD.is_terminated IS DISTINCT FROM NEW.is_terminated OR
    OLD.first_signal_at IS DISTINCT FROM NEW.first_signal_at OR
    OLD.preview_url IS DISTINCT FROM NEW.preview_url OR
    OLD.preview_revision IS DISTINCT FROM NEW.preview_revision OR
    OLD.display_name IS DISTINCT FROM NEW.display_name OR
    OLD.terminate_on_pr_merge IS DISTINCT FROM NEW.terminate_on_pr_merge OR
    OLD.is_pinned IS DISTINCT FROM NEW.is_pinned OR
    OLD.pinned_at IS DISTINCT FROM NEW.pinned_at OR
    OLD.session_mode IS DISTINCT FROM NEW.session_mode OR
    OLD.auto_inject_review IS DISTINCT FROM NEW.auto_inject_review OR
    OLD.auto_review_enabled IS DISTINCT FROM NEW.auto_review_enabled OR
    OLD.harness IS DISTINCT FROM NEW.harness OR
    OLD.runtime_launch_id IS DISTINCT FROM NEW.runtime_launch_id OR
    OLD.agent_session_id IS DISTINCT FROM NEW.agent_session_id OR
    OLD.native_transcript_path IS DISTINCT FROM NEW.native_transcript_path OR
    OLD.auto_inject_ci IS DISTINCT FROM NEW.auto_inject_ci
)
EXECUTE FUNCTION ao_capture_change_event(
    'session_updated', 'project_id', 'id', 'session');

CREATE TRIGGER ao_pull_requests_change_created
AFTER INSERT ON ao_pull_requests
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'pr_created', '@session', 'session_id', 'pull_request');

CREATE TRIGGER ao_pull_requests_change_updated
AFTER UPDATE ON ao_pull_requests
FOR EACH ROW
WHEN (
    OLD.pr_state IS DISTINCT FROM NEW.pr_state OR
    OLD.ci_state IS DISTINCT FROM NEW.ci_state OR
    OLD.review_decision IS DISTINCT FROM NEW.review_decision OR
    OLD.mergeability IS DISTINCT FROM NEW.mergeability
)
EXECUTE FUNCTION ao_capture_change_event(
    'pr_updated', '@session', 'session_id', 'pull_request');

CREATE TRIGGER ao_pull_requests_change_session
AFTER UPDATE ON ao_pull_requests
FOR EACH ROW WHEN (OLD.session_id IS DISTINCT FROM NEW.session_id)
EXECUTE FUNCTION ao_capture_change_event(
    'pr_session_changed', '@session', 'session_id', 'pull_request_session');

CREATE TRIGGER ao_pull_request_checks_change_inserted
AFTER INSERT ON ao_pull_request_checks
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'pr_check_recorded', '@pull_request', '', 'check');

CREATE TRIGGER ao_pull_request_checks_change_updated
AFTER UPDATE ON ao_pull_request_checks
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION ao_capture_change_event(
    'pr_check_recorded', '@pull_request', '', 'check');

CREATE TRIGGER ao_pull_request_review_threads_change_added
AFTER INSERT ON ao_pull_request_review_threads
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'pr_review_thread_added', '@pull_request', '', 'review_thread');

CREATE TRIGGER ao_pull_request_review_threads_change_resolved
AFTER UPDATE ON ao_pull_request_review_threads
FOR EACH ROW WHEN (OLD.resolved IS DISTINCT FROM NEW.resolved)
EXECUTE FUNCTION ao_capture_change_event(
    'pr_review_thread_resolved', '@pull_request', '', 'review_thread');

CREATE TRIGGER ao_pull_request_reviews_change_created
AFTER INSERT ON ao_pull_request_reviews
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'review_run_created', '@pull_request', '', 'review');

CREATE TRIGGER ao_pull_request_reviews_change_updated
AFTER UPDATE ON ao_pull_request_reviews
FOR EACH ROW
WHEN (
    OLD.state IS DISTINCT FROM NEW.state OR
    OLD.target_sha IS DISTINCT FROM NEW.target_sha OR
    OLD.body IS DISTINCT FROM NEW.body OR
    OLD.auto_inject_review IS DISTINCT FROM NEW.auto_inject_review
)
EXECUTE FUNCTION ao_capture_change_event(
    'review_run_updated', '@pull_request', '', 'review');

CREATE TRIGGER ao_notifications_change_created
AFTER INSERT ON ao_notifications
FOR EACH ROW EXECUTE FUNCTION ao_capture_change_event(
    'notification_created', 'project_id', 'session_id', 'notification');

CREATE TRIGGER ao_notifications_change_resolved
AFTER UPDATE OF resolved_at ON ao_notifications
FOR EACH ROW
WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
EXECUTE FUNCTION ao_capture_change_event(
    'notification_resolved', 'project_id', 'session_id', 'notification');

-- +goose Down
DROP TRIGGER IF EXISTS ao_notifications_change_resolved ON ao_notifications;
DROP TRIGGER IF EXISTS ao_notifications_change_created ON ao_notifications;
DROP TRIGGER IF EXISTS ao_pull_request_reviews_change_updated ON ao_pull_request_reviews;
DROP TRIGGER IF EXISTS ao_pull_request_reviews_change_created ON ao_pull_request_reviews;
DROP TRIGGER IF EXISTS ao_pull_request_review_threads_change_resolved ON ao_pull_request_review_threads;
DROP TRIGGER IF EXISTS ao_pull_request_review_threads_change_added ON ao_pull_request_review_threads;
DROP TRIGGER IF EXISTS ao_pull_request_checks_change_updated ON ao_pull_request_checks;
DROP TRIGGER IF EXISTS ao_pull_request_checks_change_inserted ON ao_pull_request_checks;
DROP TRIGGER IF EXISTS ao_pull_requests_change_session ON ao_pull_requests;
DROP TRIGGER IF EXISTS ao_pull_requests_change_updated ON ao_pull_requests;
DROP TRIGGER IF EXISTS ao_pull_requests_change_created ON ao_pull_requests;
DROP TRIGGER IF EXISTS ao_sessions_change_updated ON ao_sessions;
DROP TRIGGER IF EXISTS ao_sessions_change_created ON ao_sessions;
