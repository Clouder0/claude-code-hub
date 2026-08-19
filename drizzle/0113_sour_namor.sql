CREATE TABLE IF NOT EXISTS "security_event" (
"id" serial PRIMARY KEY NOT NULL,
"user_id" integer NOT NULL,
"message_request_id" integer,
"type" varchar(32) NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_event" ADD CONSTRAINT "security_event_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_event" ADD CONSTRAINT "security_event_message_request_id_message_request_id_fk" FOREIGN KEY ("message_request_id") REFERENCES "public"."message_request"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_security_event_request_type_unique" ON "security_event" USING btree ("message_request_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_event_created_at" ON "security_event" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_event_user_type_created_at" ON "security_event" USING btree ("user_id","type","created_at");
