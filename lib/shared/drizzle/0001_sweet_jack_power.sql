CREATE TYPE "public"."cut_mode" AS ENUM('camera', 'deck');--> statement-breakpoint
ALTER TYPE "public"."source_role" ADD VALUE 'render';--> statement-breakpoint
ALTER TYPE "public"."source_role" ADD VALUE 'deck';--> statement-breakpoint
CREATE TABLE "cut_events" (
	"id" text PRIMARY KEY NOT NULL,
	"cut_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"command" jsonb NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cut_slides" (
	"id" text PRIMARY KEY NOT NULL,
	"cut_id" text NOT NULL,
	"slide_id" text NOT NULL,
	"position" integer NOT NULL,
	"anchor_cut_brick_id" text,
	"anchor_source_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "slides" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"index" integer NOT NULL,
	"image_key" text NOT NULL,
	"title" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "revisions" RENAME COLUMN "edl" TO "resolved_edl";--> statement-breakpoint
ALTER TABLE "cuts" ADD COLUMN "mode" "cut_mode" DEFAULT 'camera' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "origin_revision" text;--> statement-breakpoint
ALTER TABLE "cut_events" ADD CONSTRAINT "cut_events_cut_id_cuts_id_fk" FOREIGN KEY ("cut_id") REFERENCES "public"."cuts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut_slides" ADD CONSTRAINT "cut_slides_cut_id_cuts_id_fk" FOREIGN KEY ("cut_id") REFERENCES "public"."cuts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut_slides" ADD CONSTRAINT "cut_slides_slide_id_slides_id_fk" FOREIGN KEY ("slide_id") REFERENCES "public"."slides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cut_slides" ADD CONSTRAINT "cut_slides_anchor_cut_brick_id_cut_bricks_id_fk" FOREIGN KEY ("anchor_cut_brick_id") REFERENCES "public"."cut_bricks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slides" ADD CONSTRAINT "slides_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cut_events_cut_sequence_unique" ON "cut_events" USING btree ("cut_id","sequence");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_origin_revision_revisions_id_fk" FOREIGN KEY ("origin_revision") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;