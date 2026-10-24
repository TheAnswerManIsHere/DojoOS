ALTER TABLE "bricks" ALTER COLUMN "out_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cut_events" ALTER COLUMN "cut_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cut_events" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "cut_events" ADD CONSTRAINT "cut_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cut_events_source_sequence_unique" ON "cut_events" USING btree ("source_id","sequence");--> statement-breakpoint
ALTER TABLE "cut_events" ADD CONSTRAINT "cut_events_one_owner" CHECK (num_nonnulls("cut_events"."cut_id", "cut_events"."source_id") = 1);