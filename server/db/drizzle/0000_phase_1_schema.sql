CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" text,
	"username" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"installation_id" uuid,
	"repository_id" uuid,
	"payload_digest" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_status" text DEFAULT 'received' NOT NULL,
	CONSTRAINT "webhook_deliveries_processing_status_check" CHECK ("webhook_deliveries"."processing_status" in ('received','processed','ignored','failed'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"idempotency_key" text,
	"source_sha" text NOT NULL,
	"target_branch" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in (
        'queued','running','report_only','awaiting_hitl',
        'changes_requested','publishing','succeeded','aborted','failed'
      ))
);
--> statement-breakpoint
CREATE TABLE "sandbox_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"candidate_hash" text,
	"base_sha" text NOT NULL,
	"commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" text NOT NULL,
	"exit_code" integer,
	"artifact_ref" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_results_verdict_check" CHECK ("sandbox_results"."verdict" in ('pass','fail','timeout','error')),
	CONSTRAINT "sandbox_results_baseline_candidate_check" CHECK (("sandbox_results"."attempt_number" = 0 and "sandbox_results"."candidate_hash" is null)
          or ("sandbox_results"."attempt_number" > 0 and "sandbox_results"."candidate_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "patch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"candidate_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"failure_reason" text,
	"patch_diff" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "patch_attempts_outcome_check" CHECK ("patch_attempts"."outcome" in ('success','failed_validation','generation_error'))
);
--> statement-breakpoint
CREATE TABLE "triage_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"parsed_error" text,
	"file_path" text,
	"line_number" integer,
	"failing_tests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_results_category_check" CHECK ("triage_results"."category" in ('repairable','report_only'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"run_version" integer NOT NULL,
	"candidate_hash" text NOT NULL,
	"base_sha" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('active','invalidated')),
	CONSTRAINT "approvals_invalidated_reason_check" CHECK ("approvals"."invalidated_reason" is null or "approvals"."invalidated_reason" in (
        'request_changes','run_version_changed','candidate_changed','base_sha_changed'
      ))
);
--> statement-breakpoint
CREATE TABLE "hitl_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"run_version" integer NOT NULL,
	"candidate_hash" text,
	"base_sha" text NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hitl_decisions_action_check" CHECK ("hitl_decisions"."action" in ('approve','request_changes','abort'))
);
--> statement-breakpoint
CREATE TABLE "pr_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"github_pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"base_sha" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"input_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_outcome_check" CHECK ("tool_invocations"."outcome" in ('success','failure'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_results" ADD CONSTRAINT "sandbox_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_attempts" ADD CONSTRAINT "patch_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_id_hitl_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."hitl_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_decisions" ADD CONSTRAINT "hitl_decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_decisions" ADD CONSTRAINT "hitl_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_publications" ADD CONSTRAINT "pr_publications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_publications" ADD CONSTRAINT "pr_publications_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uidx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_user_id_uidx" ON "users" USING btree ("github_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id_uidx" ON "github_installations" USING btree ("github_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_github_repo_id_uidx" ON "repositories" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_owner_name_uidx" ON "repositories" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX "repositories_installation_id_idx" ON "repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_uidx" ON "webhook_deliveries" USING btree ("github_delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_repository_id_idx" ON "webhook_deliveries" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_repo_idempotency_key_uidx" ON "runs" USING btree ("repository_id","idempotency_key") WHERE "runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runs_repository_created_idx" ON "runs" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_pending_status_idx" ON "runs" USING btree ("status") WHERE "runs"."status" in ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_results_run_attempt_uidx" ON "sandbox_results" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "patch_attempts_run_attempt_uidx" ON "patch_attempts" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "triage_results_run_id_uidx" ON "triage_results" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_run_id_uidx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_active_idx" ON "approvals" USING btree ("status") WHERE "approvals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "hitl_decisions_run_id_idx" ON "hitl_decisions" USING btree ("run_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_publications_run_id_uidx" ON "pr_publications" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_publications_repo_pr_number_uidx" ON "pr_publications" USING btree ("repository_id","github_pr_number");--> statement-breakpoint
CREATE INDEX "audit_events_run_id_idx" ON "audit_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_id_idx" ON "tool_invocations" USING btree ("run_id","started_at");