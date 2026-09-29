import { relations } from "drizzle-orm";
import { boolean, date, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ulid } from "ulid";

const uid = () => ulid();
const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};
const id = () => text("id").primaryKey().$defaultFn(uid);

export const tierEnum = pgEnum("user_tier", ["operator", "tester"]);
export const roleEnum = pgEnum("source_role", ["camera_a", "camera_b", "audio"]);
export const ingestEnum = pgEnum("ingest_state", ["uploading", "uploaded", "probing", "proxying", "transcribing", "ready", "failed"]);
export const cutKindEnum = pgEnum("cut_kind", ["lesson", "short"]);
export const cutStateEnum = pgEnum("cut_state", ["draft", "approved"]);
export const jobStateEnum = pgEnum("job_state", ["queued", "claimed", "completed", "failed"]);

export const users = pgTable("users", { id: id(), email: text("email").notNull(), tier: tierEnum("tier").notNull(), ...audit }, (t) => [uniqueIndex("users_email_unique").on(t.email)]);
export const shoots = pgTable("shoots", { id: id(), name: text("name").notNull(), shotOn: date("shot_on"), notes: text("notes"), ...audit });
export const sources = pgTable("sources", {
  id: id(), shootId: text("shoot_id").notNull().references(() => shoots.id), role: roleEnum("role").notNull(),
  originalKey: text("original_key").notNull(), proxyKey: text("proxy_key"), spriteKey: text("sprite_key"), peaksKey: text("peaks_key"),
  probe: jsonb("probe"), ingestState: ingestEnum("ingest_state").notNull().default("uploading"),
  durationMs: integer("duration_ms"), width: integer("width"), height: integer("height"), fps: real("fps"), ...audit,
});
export const transcripts = pgTable("transcripts", {
  id: id(), sourceId: text("source_id").notNull().references(() => sources.id), provider: text("provider").notNull(),
  version: text("version").notNull(), words: jsonb("words").$type<Array<{ text: string; start_ms: number; end_ms: number }>>().notNull(), ...audit,
});
export const bricks = pgTable("bricks", {
  id: id(), sourceId: text("source_id").notNull().references(() => sources.id), inMs: integer("in_ms").notNull(),
  outMs: integer("out_ms").notNull(), attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  tags: text("tags").array().notNull().default([]), beatId: text("beat_id"), isChosen: boolean("is_chosen").notNull().default(false), ...audit,
});
export const templates = pgTable("templates", { id: id(), name: text("name").notNull(), spec: jsonb("spec").$type<Record<string, unknown>>().notNull(), ...audit });
export const cuts = pgTable("cuts", {
  id: id(), shootId: text("shoot_id").notNull().references(() => shoots.id), kind: cutKindEnum("kind").notNull(),
  templateId: text("template_id").references(() => templates.id), name: text("name").notNull(), state: cutStateEnum("state").notNull().default("draft"), ...audit,
});
export const cutBricks = pgTable("cut_bricks", {
  id: id(), cutId: text("cut_id").notNull().references(() => cuts.id), brickId: text("brick_id").notNull().references(() => bricks.id),
  position: integer("position").notNull(), overrides: jsonb("overrides").$type<{
    trimDeltas?: { inMs: number; outMs: number };
    framing?: Record<string, Array<{ atMs: number; x: number; y: number; scale: number }>>;
    transition?: string; narrationSilence?: boolean;
  }>().notNull().default({}), ...audit,
});
export const captions = pgTable("captions", {
  id: id(), cutId: text("cut_id").notNull().references(() => cuts.id), startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(), text: text("text").notNull(), styleRef: text("style_ref"), ...audit,
});
export const revisions = pgTable("revisions", {
  id: id(), cutId: text("cut_id").notNull().references(() => cuts.id), number: integer("number").notNull(),
  edl: jsonb("edl").notNull(), templateSnapshot: jsonb("template_snapshot").notNull(),
  renderKey: text("render_key"), metadata: jsonb("metadata").notNull().default({}),
  digest: text("digest").notNull(), approvedAt: timestamp("approved_at", { withTimezone: true }), ...audit,
}, (t) => [uniqueIndex("revisions_cut_number_unique").on(t.cutId, t.number)]);
export const jobs = pgTable("jobs", {
  id: id(), kind: text("kind").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  state: jobStateEnum("state").notNull().default("queued"), attempts: integer("attempts").notNull().default(0),
  claimedBy: text("claimed_by"), claimedAt: timestamp("claimed_at", { withTimezone: true }),
  result: jsonb("result"), error: text("error"), ...audit,
});
export const questions = pgTable("questions", {
  id: id(), feature: text("feature").notNull(), key: text("key").notNull(), prompt: text("prompt").notNull(),
  position: integer("position").notNull(), active: boolean("active").notNull().default(true), ...audit,
}, (t) => [uniqueIndex("questions_key_unique").on(t.key)]);
export const feedback = pgTable("feedback", {
  id: id(), userId: text("user_id").notNull().references(() => users.id), questionKey: text("question_key").notNull().references(() => questions.key),
  answer: text("answer").notNull(), page: text("page").notNull(), buildVersion: text("build_version").notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(), ...audit,
});
// Operational records, not product entities; both survive process restarts.
export const magicTokens = pgTable("magic_tokens", {
  id: id(), userId: text("user_id").notNull().references(() => users.id), tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), usedAt: timestamp("used_at", { withTimezone: true }), ...audit,
});
export const sessions = pgTable("sessions", {
  id: id(), userId: text("user_id").notNull().references(() => users.id), tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), ...audit,
});
export const uploads = pgTable("uploads", {
  id: id(), sourceId: text("source_id").notNull().references(() => sources.id), uploadId: text("upload_id").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }), ...audit,
});

export const shootsRelations = relations(shoots, ({ many }) => ({ sources: many(sources), cuts: many(cuts) }));
export const sourcesRelations = relations(sources, ({ one, many }) => ({
  shoot: one(shoots, { fields: [sources.shootId], references: [shoots.id] }),
  transcripts: many(transcripts), bricks: many(bricks), uploads: many(uploads),
}));
export const transcriptsRelations = relations(transcripts, ({ one }) => ({ source: one(sources, { fields: [transcripts.sourceId], references: [sources.id] }) }));
export const bricksRelations = relations(bricks, ({ one, many }) => ({ source: one(sources, { fields: [bricks.sourceId], references: [sources.id] }), cutBricks: many(cutBricks) }));
export const cutsRelations = relations(cuts, ({ one, many }) => ({
  shoot: one(shoots, { fields: [cuts.shootId], references: [shoots.id] }),
  template: one(templates, { fields: [cuts.templateId], references: [templates.id] }),
  cutBricks: many(cutBricks), captions: many(captions), revisions: many(revisions),
}));
export const templatesRelations = relations(templates, ({ many }) => ({ cuts: many(cuts) }));
export const cutBricksRelations = relations(cutBricks, ({ one }) => ({
  cut: one(cuts, { fields: [cutBricks.cutId], references: [cuts.id] }),
  brick: one(bricks, { fields: [cutBricks.brickId], references: [bricks.id] }),
}));
export const captionsRelations = relations(captions, ({ one }) => ({ cut: one(cuts, { fields: [captions.cutId], references: [cuts.id] }) }));
export const revisionsRelations = relations(revisions, ({ one }) => ({ cut: one(cuts, { fields: [revisions.cutId], references: [cuts.id] }) }));
export const feedbackRelations = relations(feedback, ({ one }) => ({
  user: one(users, { fields: [feedback.userId], references: [users.id] }),
  question: one(questions, { fields: [feedback.questionKey], references: [questions.key] }),
}));
export const questionsRelations = relations(questions, ({ many }) => ({ feedback: many(feedback) }));
export const usersRelations = relations(users, ({ many }) => ({ feedback: many(feedback), sessions: many(sessions), magicTokens: many(magicTokens) }));
export const sessionsRelations = relations(sessions, ({ one }) => ({ user: one(users, { fields: [sessions.userId], references: [users.id] }) }));
export const magicTokensRelations = relations(magicTokens, ({ one }) => ({ user: one(users, { fields: [magicTokens.userId], references: [users.id] }) }));
export const uploadsRelations = relations(uploads, ({ one }) => ({ source: one(sources, { fields: [uploads.sourceId], references: [sources.id] }) }));