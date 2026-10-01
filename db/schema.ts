// Postgres schema for Netlify Database. Ported from the original MySQL schema
// (db/schema.sql). Column names are stored lower-case because Postgres folds
// unquoted identifiers, so the app's existing camelCase SQL (e.g. "fullName")
// keeps working unchanged; server/server/db/queries.js maps result keys back
// to camelCase.
import { bigint, bigserial, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const directMessages = pgTable(
  "direct_messages",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    senderId: varchar("senderid", { length: 36 }),
    recipientId: varchar("recipientid", { length: 36 }),
    body: text("body"),
    readAt: timestamp("readat", { withTimezone: true }),
    createdAt: timestamp("createdat", { withTimezone: true }),
  },
  (t) => [
    index("idx_dm_sender").on(t.senderId, t.createdAt),
    index("idx_dm_recipient").on(t.recipientId, t.createdAt),
  ]
);

export const ethics = pgTable(
  "ethics",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    submitterId: varchar("submitterid", { length: 36 }),
    submitterName: varchar("submittername", { length: 160 }),
    title: varchar("title", { length: 255 }),
    researchers: varchar("researchers", { length: 255 }),
    adviser: varchar("adviser", { length: 160 }),
    department: varchar("department", { length: 160 }),
    participantType: varchar("participanttype", { length: 60 }),
    riskLevel: varchar("risklevel", { length: 60 }),
    status: varchar("status", { length: 60 }).default("submitted"),
    statusHistory: text("statushistory"),
    files: text("files"),
    additionalDocs: text("additionaldocs"),
    comments: text("comments"),
    certificate: text("certificate"),
    compliance: text("compliance"),
    revisedDocuments: text("reviseddocuments"),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
  },
  (t) => [
    index("idx_eth_submitter").on(t.submitterId),
  ]
);

export const eventAbstracts = pgTable(
  "event_abstracts",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    eventId: varchar("eventid", { length: 36 }),
    userId: varchar("userid", { length: 36 }),
    title: varchar("title", { length: 255 }),
    authors: varchar("authors", { length: 255 }),
    abstract: text("abstract"),
    keywords: varchar("keywords", { length: 255 }),
    strand: varchar("strand", { length: 120 }),
    status: varchar("status", { length: 40 }).default("submitted"),
    createdAt: timestamp("createdat", { withTimezone: true }),
  },
  (t) => [
    index("idx_abs_event").on(t.eventId),
  ]
);

export const eventRegistrations = pgTable(
  "event_registrations",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    eventId: varchar("eventid", { length: 36 }),
    userId: varchar("userid", { length: 36 }),
    participantName: varchar("participantname", { length: 160 }),
    institution: varchar("institution", { length: 160 }),
    email: varchar("email", { length: 160 }),
    participantType: varchar("participanttype", { length: 40 }),
    role: varchar("role", { length: 40 }).default("attendee"),
    abstractFile: varchar("abstractfile", { length: 255 }),
    attendanceStatus: varchar("attendancestatus", { length: 40 }).default("absent"),
    certificateIssued: smallint("certificateissued").default(0),
    certificateData: text("certificatedata"),
    createdAt: timestamp("createdat", { withTimezone: true }),
  },
  (t) => [
    index("idx_reg_event").on(t.eventId),
  ]
);

export const eventsModule = pgTable(
  "events_module",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    title: varchar("title", { length: 255 }),
    theme: varchar("theme", { length: 255 }),
    dateTime: varchar("datetime", { length: 40 }),
    venue: varchar("venue", { length: 255 }),
    description: text("description"),
    registrationLink: varchar("registrationlink", { length: 255 }),
    programFlow: text("programflow"),
    speakers: text("speakers"),
    gallery: text("gallery"),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
    photo: varchar("photo", { length: 500 }).default(""),
  }
);

export const innovationExtension = pgTable(
  "innovation_extension",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    projectType: varchar("projecttype", { length: 60 }),
    title: varchar("title", { length: 255 }),
    proponents: varchar("proponents", { length: 255 }),
    department: varchar("department", { length: 160 }),
    description: text("description"),
    beneficiaries: integer("beneficiaries").default(0),
    implementationDate: varchar("implementationdate", { length: 40 }),
    outputProduct: text("outputproduct"),
    communityPartner: varchar("communitypartner", { length: 255 }),
    needsAssessment: text("needsassessment"),
    interventionConducted: text("interventionconducted"),
    evaluationResult: text("evaluationresult"),
    communityOutcome: text("communityoutcome"),
    sustainabilityPlan: text("sustainabilityplan"),
    supportingDocuments: text("supportingdocuments"),
    impactDocuments: text("impactdocuments"),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
  },
  (t) => [
    index("idx_inno_type").on(t.projectType),
  ]
);

export const inquiries = pgTable(
  "inquiries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: varchar("name", { length: 160 }),
    email: varchar("email", { length: 160 }),
    subject: varchar("subject", { length: 255 }),
    message: text("message"),
    receivedAt: timestamp("receivedat", { withTimezone: true }).defaultNow(),
  }
);

export const notifications = pgTable(
  "notifications",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    userId: varchar("userid", { length: 36 }),
    action: varchar("action", { length: 80 }),
    title: varchar("title", { length: 255 }),
    message: text("message"),
    link: varchar("link", { length: 255 }),
    readAt: timestamp("readat", { withTimezone: true }),
    createdAt: timestamp("createdat", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_notif_user").on(t.userId, t.createdAt),
  ]
);

export const publications = pgTable(
  "publications",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    title: varchar("title", { length: 255 }),
    authors: varchar("authors", { length: 255 }),
    journalOrConference: varchar("journalorconference", { length: 255 }),
    publicationDate: varchar("publicationdate", { length: 40 }),
    volume: varchar("volume", { length: 40 }),
    issue: varchar("issue", { length: 40 }),
    pages: varchar("pages", { length: 40 }),
    doi: varchar("doi", { length: 160 }),
    publicationLink: varchar("publicationlink", { length: 255 }),
    indexingStatus: varchar("indexingstatus", { length: 120 }),
    pubType: varchar("pubtype", { length: 60 }),
    status: varchar("status", { length: 40 }),
    authorType: varchar("authortype", { length: 40 }),
    department: varchar("department", { length: 160 }),
    schoolYear: varchar("schoolyear", { length: 40 }),
    proofDocuments: text("proofdocuments"),
    submitterId: varchar("submitterid", { length: 36 }),
    submitterName: varchar("submittername", { length: 160 }),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
    sourceSubmissionId: varchar("sourcesubmissionid", { length: 36 }),
  },
  (t) => [
    index("idx_pubs_submitter").on(t.submitterId),
    index("idx_pubs_source").on(t.sourceSubmissionId),
  ]
);

export const repository = pgTable(
  "repository",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    sourceSubmissionId: varchar("sourcesubmissionid", { length: 36 }),
    title: varchar("title", { length: 255 }),
    authors: varchar("authors", { length: 255 }),
    adviser: varchar("adviser", { length: 160 }),
    department: varchar("department", { length: 160 }),
    abstract: text("abstract"),
    keywords: varchar("keywords", { length: 255 }),
    category: varchar("category", { length: 120 }),
    yearCompleted: varchar("yearcompleted", { length: 40 }),
    status: varchar("status", { length: 40 }),
    fileAvailable: smallint("fileavailable").default(0),
    accessLevel: varchar("accesslevel", { length: 40 }),
    citation: text("citation"),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
  },
  (t) => [
    index("idx_repo_source").on(t.sourceSubmissionId),
  ]
);

export const researchers = pgTable(
  "researchers",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    type: varchar("type", { length: 40 }),
    fullName: varchar("fullname", { length: 160 }),
    department: varchar("department", { length: 160 }),
    program: varchar("program", { length: 160 }),
    researchInterests: text("researchinterests"),
    completedResearches: text("completedresearches"),
    publishedWorks: text("publishedworks"),
    presentedPapers: text("presentedpapers"),
    awards: text("awards"),
    innovationProjects: text("innovationprojects"),
    citations: integer("citations").default(0),
    orcid: varchar("orcid", { length: 80 }),
    googleScholar: varchar("googlescholar", { length: 255 }),
    researchGate: varchar("researchgate", { length: 255 }),
    researchTitle: varchar("researchtitle", { length: 255 }),
    adviser: varchar("adviser", { length: 160 }),
    yearCompleted: varchar("yearcompleted", { length: 40 }),
    researchOutputStatus: varchar("researchoutputstatus", { length: 60 }),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
  }
);

export const submissions = pgTable(
  "submissions",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    submitterId: varchar("submitterid", { length: 36 }),
    submitterName: varchar("submittername", { length: 160 }),
    title: varchar("title", { length: 255 }),
    authors: varchar("authors", { length: 255 }),
    program: varchar("program", { length: 160 }),
    adviser: varchar("adviser", { length: 160 }),
    category: varchar("category", { length: 120 }),
    researchType: varchar("researchtype", { length: 120 }),
    abstract: text("abstract"),
    keywords: varchar("keywords", { length: 255 }),
    schoolYear: varchar("schoolyear", { length: 40 }),
    semester: varchar("semester", { length: 40 }),
    status: varchar("status", { length: 40 }).default("submitted"),
    statusHistory: text("statushistory"),
    files: text("files"),
    additionalDocs: text("additionaldocs"),
    versions: text("versions"),
    comments: text("comments"),
    createdAt: timestamp("createdat", { withTimezone: true }),
    updatedAt: timestamp("updatedat", { withTimezone: true }),
  },
  (t) => [
    index("idx_submissions_submitter").on(t.submitterId),
  ]
);

export const systemLogs = pgTable(
  "system_logs",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    action: varchar("action", { length: 80 }),
    details: text("details"),
    userId: varchar("userid", { length: 36 }),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("useragent"),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow(),
  }
);

export const users = pgTable(
  "users",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    username: varchar("username", { length: 80 }).notNull(),
    email: varchar("email", { length: 160 }).notNull(),
    fullName: varchar("fullname", { length: 160 }).default(""),
    role: varchar("role", { length: 30 }).notNull(),
    passwordHash: varchar("passwordhash", { length: 120 }).notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    department: varchar("department", { length: 120 }).default(""),
    contactNumber: varchar("contactnumber", { length: 60 }).default(""),
    researchInterests: text("researchinterests"),
    profilePhoto: varchar("profilephoto", { length: 255 }),
    researches: text("researches"),
    resetToken: varchar("resettoken", { length: 120 }),
    resetTokenExpiry: bigint("resettokenexpiry", { mode: "number" }),
    createdAt: timestamp("createdat", { withTimezone: true }).defaultNow(),
    userPrefs: text("user_prefs"),
    setupPending: smallint("setuppending").default(0),
  },
  (t) => [
    uniqueIndex("users_username_unique").on(t.username),
  ]
);

// Express sessions (replaces the file-backed session store).
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid", { length: 255 }).primaryKey(),
    sess: text("sess").notNull(),
    expiresAt: timestamp("expiresat", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedat", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_sessions_expires").on(t.expiresAt)]
);

// Admin-editable site content (announcements, events, profile, …) and other
// JSON documents that used to be written into server/data/*.json.
export const siteContent = pgTable("site_content", {
  name: varchar("name", { length: 120 }).primaryKey(),
  data: text("data").notNull(),
  updatedAt: timestamp("updatedat", { withTimezone: true }).defaultNow(),
});

// Short-lived values that used to live in in-memory Maps (email verification
// codes, rate limits, Google bridge codes). Serverless instances do not share
// memory, so these are kept in the database instead.
export const kvStore = pgTable(
  "kv_store",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresat", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_kv_expires").on(t.expiresAt)]
);
