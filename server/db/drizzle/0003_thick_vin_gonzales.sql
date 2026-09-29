ALTER TABLE "oauth_states" DROP CONSTRAINT "oauth_states_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "oauth_states_state_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_uidx" ON "oauth_states" USING btree ("state");--> statement-breakpoint
ALTER TABLE "oauth_states" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_provider_check" CHECK ("oauth_states"."provider" in ('github', 'google'));