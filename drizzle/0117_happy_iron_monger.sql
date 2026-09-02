ALTER TABLE "security_event" ADD COLUMN "client_instance_id" varchar(256);--> statement-breakpoint
ALTER TABLE "security_event" ADD COLUMN "central_status" varchar(16) DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_event" ADD COLUMN "central_error" varchar(128);--> statement-breakpoint
ALTER TABLE "security_event" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "security_event"
SET "central_status" = 'unconfirmed', "central_error" = 'legacy_pre_strict_bio'
WHERE "type" = 'bio_policy';
