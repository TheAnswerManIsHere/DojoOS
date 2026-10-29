ALTER TABLE "bricks" ADD COLUMN "number" integer;--> statement-breakpoint
-- Existing bricks are numbered once, per shoot, in the order they were marked.
UPDATE "bricks" AS b SET "number" = n.rn FROM (
  SELECT b2."id", row_number() OVER (PARTITION BY s."shoot_id" ORDER BY b2."created_at", b2."id") AS rn
  FROM "bricks" b2 JOIN "sources" s ON s."id" = b2."source_id"
) AS n WHERE n."id" = b."id";
