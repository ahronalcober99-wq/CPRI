CREATE TABLE "direct_messages" (
	"id" varchar(36) PRIMARY KEY,
	"senderid" varchar(36),
	"recipientid" varchar(36),
	"body" text,
	"readat" timestamp with time zone,
	"createdat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ethics" (
	"id" varchar(36) PRIMARY KEY,
	"submitterid" varchar(36),
	"submittername" varchar(160),
	"title" varchar(255),
	"researchers" varchar(255),
	"adviser" varchar(160),
	"department" varchar(160),
	"participanttype" varchar(60),
	"risklevel" varchar(60),
	"status" varchar(60) DEFAULT 'submitted',
	"statushistory" text,
	"files" text,
	"additionaldocs" text,
	"comments" text,
	"certificate" text,
	"compliance" text,
	"reviseddocuments" text,
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_abstracts" (
	"id" varchar(36) PRIMARY KEY,
	"eventid" varchar(36),
	"userid" varchar(36),
	"title" varchar(255),
	"authors" varchar(255),
	"abstract" text,
	"keywords" varchar(255),
	"strand" varchar(120),
	"status" varchar(40) DEFAULT 'submitted',
	"createdat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_registrations" (
	"id" varchar(36) PRIMARY KEY,
	"eventid" varchar(36),
	"userid" varchar(36),
	"participantname" varchar(160),
	"institution" varchar(160),
	"email" varchar(160),
	"participanttype" varchar(40),
	"role" varchar(40) DEFAULT 'attendee',
	"abstractfile" varchar(255),
	"attendancestatus" varchar(40) DEFAULT 'absent',
	"certificateissued" smallint DEFAULT 0,
	"certificatedata" text,
	"createdat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events_module" (
	"id" varchar(36) PRIMARY KEY,
	"title" varchar(255),
	"theme" varchar(255),
	"datetime" varchar(40),
	"venue" varchar(255),
	"description" text,
	"registrationlink" varchar(255),
	"programflow" text,
	"speakers" text,
	"gallery" text,
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone,
	"photo" varchar(500) DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE "innovation_extension" (
	"id" varchar(36) PRIMARY KEY,
	"projecttype" varchar(60),
	"title" varchar(255),
	"proponents" varchar(255),
	"department" varchar(160),
	"description" text,
	"beneficiaries" integer DEFAULT 0,
	"implementationdate" varchar(40),
	"outputproduct" text,
	"communitypartner" varchar(255),
	"needsassessment" text,
	"interventionconducted" text,
	"evaluationresult" text,
	"communityoutcome" text,
	"sustainabilityplan" text,
	"supportingdocuments" text,
	"impactdocuments" text,
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inquiries" (
	"id" bigserial PRIMARY KEY,
	"name" varchar(160),
	"email" varchar(160),
	"subject" varchar(255),
	"message" text,
	"receivedat" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "kv_store" (
	"key" varchar(255) PRIMARY KEY,
	"value" text NOT NULL,
	"expiresat" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(36) PRIMARY KEY,
	"userid" varchar(36),
	"action" varchar(80),
	"title" varchar(255),
	"message" text,
	"link" varchar(255),
	"readat" timestamp with time zone,
	"createdat" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" varchar(36) PRIMARY KEY,
	"title" varchar(255),
	"authors" varchar(255),
	"journalorconference" varchar(255),
	"publicationdate" varchar(40),
	"volume" varchar(40),
	"issue" varchar(40),
	"pages" varchar(40),
	"doi" varchar(160),
	"publicationlink" varchar(255),
	"indexingstatus" varchar(120),
	"pubtype" varchar(60),
	"status" varchar(40),
	"authortype" varchar(40),
	"department" varchar(160),
	"schoolyear" varchar(40),
	"proofdocuments" text,
	"submitterid" varchar(36),
	"submittername" varchar(160),
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone,
	"sourcesubmissionid" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"id" varchar(36) PRIMARY KEY,
	"sourcesubmissionid" varchar(36),
	"title" varchar(255),
	"authors" varchar(255),
	"adviser" varchar(160),
	"department" varchar(160),
	"abstract" text,
	"keywords" varchar(255),
	"category" varchar(120),
	"yearcompleted" varchar(40),
	"status" varchar(40),
	"fileavailable" smallint DEFAULT 0,
	"accesslevel" varchar(40),
	"citation" text,
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "researchers" (
	"id" varchar(36) PRIMARY KEY,
	"type" varchar(40),
	"fullname" varchar(160),
	"department" varchar(160),
	"program" varchar(160),
	"researchinterests" text,
	"completedresearches" text,
	"publishedworks" text,
	"presentedpapers" text,
	"awards" text,
	"innovationprojects" text,
	"citations" integer DEFAULT 0,
	"orcid" varchar(80),
	"googlescholar" varchar(255),
	"researchgate" varchar(255),
	"researchtitle" varchar(255),
	"adviser" varchar(160),
	"yearcompleted" varchar(40),
	"researchoutputstatus" varchar(60),
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar(255) PRIMARY KEY,
	"sess" text NOT NULL,
	"expiresat" timestamp with time zone NOT NULL,
	"updatedat" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "site_content" (
	"name" varchar(120) PRIMARY KEY,
	"data" text NOT NULL,
	"updatedat" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" varchar(36) PRIMARY KEY,
	"submitterid" varchar(36),
	"submittername" varchar(160),
	"title" varchar(255),
	"authors" varchar(255),
	"program" varchar(160),
	"adviser" varchar(160),
	"category" varchar(120),
	"researchtype" varchar(120),
	"abstract" text,
	"keywords" varchar(255),
	"schoolyear" varchar(40),
	"semester" varchar(40),
	"status" varchar(40) DEFAULT 'submitted',
	"statushistory" text,
	"files" text,
	"additionaldocs" text,
	"versions" text,
	"comments" text,
	"createdat" timestamp with time zone,
	"updatedat" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system_logs" (
	"id" varchar(36) PRIMARY KEY,
	"action" varchar(80),
	"details" text,
	"userid" varchar(36),
	"ip" varchar(64),
	"useragent" text,
	"timestamp" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY,
	"username" varchar(80) NOT NULL,
	"email" varchar(160) NOT NULL,
	"fullname" varchar(160) DEFAULT '',
	"role" varchar(30) NOT NULL,
	"passwordhash" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'active',
	"department" varchar(120) DEFAULT '',
	"contactnumber" varchar(60) DEFAULT '',
	"researchinterests" text,
	"profilephoto" varchar(255),
	"researches" text,
	"resettoken" varchar(120),
	"resettokenexpiry" bigint,
	"createdat" timestamp with time zone DEFAULT now(),
	"user_prefs" text,
	"setuppending" smallint DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX "idx_dm_sender" ON "direct_messages" ("senderid","createdat");--> statement-breakpoint
CREATE INDEX "idx_dm_recipient" ON "direct_messages" ("recipientid","createdat");--> statement-breakpoint
CREATE INDEX "idx_eth_submitter" ON "ethics" ("submitterid");--> statement-breakpoint
CREATE INDEX "idx_abs_event" ON "event_abstracts" ("eventid");--> statement-breakpoint
CREATE INDEX "idx_reg_event" ON "event_registrations" ("eventid");--> statement-breakpoint
CREATE INDEX "idx_inno_type" ON "innovation_extension" ("projecttype");--> statement-breakpoint
CREATE INDEX "idx_kv_expires" ON "kv_store" ("expiresat");--> statement-breakpoint
CREATE INDEX "idx_notif_user" ON "notifications" ("userid","createdat");--> statement-breakpoint
CREATE INDEX "idx_pubs_submitter" ON "publications" ("submitterid");--> statement-breakpoint
CREATE INDEX "idx_pubs_source" ON "publications" ("sourcesubmissionid");--> statement-breakpoint
CREATE INDEX "idx_repo_source" ON "repository" ("sourcesubmissionid");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" ("expiresat");--> statement-breakpoint
CREATE INDEX "idx_submissions_submitter" ON "submissions" ("submitterid");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");