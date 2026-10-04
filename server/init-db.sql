-- CPRI Database Initialization Script
--
-- This is the full schema for the API: every table the server queries is
-- created here. The server applies it automatically on every boot
-- (server/server.js) to the database named by DB_NAME, so it is safe to run on
-- every deploy — every statement is CREATE TABLE IF NOT EXISTS.
--
-- To run it by hand, select the database first (the server does that for you
-- from DB_NAME):
--   mysql -u root -p cpri < server/init-db.sql
--   npm run db:init            # uses DB_* from .env

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  email VARCHAR(160) NOT NULL,
  fullName VARCHAR(160) DEFAULT '',
  role VARCHAR(30) NOT NULL,
  passwordHash VARCHAR(120) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  department VARCHAR(120) DEFAULT '',
  contactNumber VARCHAR(60) DEFAULT '',
  researchInterests TEXT,
  profilePhoto VARCHAR(255) DEFAULT NULL,
  researches JSON,
  user_prefs JSON,
  setupPending TINYINT(1) DEFAULT 0,
  resetToken VARCHAR(120) DEFAULT NULL,
  resetTokenExpiry BIGINT DEFAULT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Submissions table
CREATE TABLE IF NOT EXISTS submissions (
  id VARCHAR(36) PRIMARY KEY,
  submitterId VARCHAR(36),
  submitterName VARCHAR(160),
  title VARCHAR(255), authors VARCHAR(255), program VARCHAR(160), adviser VARCHAR(160),
  category VARCHAR(120), researchType VARCHAR(120), abstract TEXT,
  keywords VARCHAR(255), schoolYear VARCHAR(40), semester VARCHAR(40),
  status VARCHAR(40) DEFAULT 'submitted',
  statusHistory JSON, files JSON, additionalDocs JSON, versions JSON, comments JSON,
  createdAt DATETIME, updatedAt DATETIME,
  KEY `idx_submissions_submitter` (`submitterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Repository table
CREATE TABLE IF NOT EXISTS repository (
  id VARCHAR(36) PRIMARY KEY,
  sourceSubmissionId VARCHAR(36) DEFAULT NULL,
  title VARCHAR(255), authors VARCHAR(255), adviser VARCHAR(160),
  department VARCHAR(160), abstract TEXT, keywords VARCHAR(255),
  category VARCHAR(120), yearCompleted VARCHAR(40), status VARCHAR(40),
  fileAvailable TINYINT(1) DEFAULT 0, accessLevel VARCHAR(40),
  citation JSON, createdAt DATETIME, updatedAt DATETIME,
  KEY `idx_repo_source` (`sourceSubmissionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Publications table
CREATE TABLE IF NOT EXISTS publications (
  id VARCHAR(36) PRIMARY KEY, title VARCHAR(255), authors VARCHAR(255),
  journalOrConference VARCHAR(255), publicationDate VARCHAR(40),
  volume VARCHAR(40), issue VARCHAR(40), pages VARCHAR(40), doi VARCHAR(160),
  publicationLink VARCHAR(255), indexingStatus VARCHAR(120), pubType VARCHAR(60),
  status VARCHAR(40), authorType VARCHAR(40), department VARCHAR(160),
  schoolYear VARCHAR(40), proofDocuments JSON, submitterId VARCHAR(36),
  submitterName VARCHAR(160), createdAt DATETIME, updatedAt DATETIME,
  sourceSubmissionId VARCHAR(36),
  KEY `idx_pubs_submitter` (`submitterId`),
  KEY `idx_pubs_source` (`sourceSubmissionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ethics table
CREATE TABLE IF NOT EXISTS ethics (
  id VARCHAR(36) PRIMARY KEY, submitterId VARCHAR(36), submitterName VARCHAR(160),
  title VARCHAR(255), researchers VARCHAR(255), adviser VARCHAR(160), department VARCHAR(160),
  participantType VARCHAR(60), riskLevel VARCHAR(60), status VARCHAR(60) DEFAULT 'submitted',
  statusHistory JSON, files JSON, additionalDocs JSON, comments JSON,
  certificate JSON, compliance JSON, revisedDocuments JSON,
  createdAt DATETIME, updatedAt DATETIME,
  KEY `idx_eth_submitter` (`submitterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Researchers table
CREATE TABLE IF NOT EXISTS researchers (
  id VARCHAR(36) PRIMARY KEY, type VARCHAR(40), fullName VARCHAR(160),
  department VARCHAR(160), program VARCHAR(160), researchInterests TEXT,
  completedResearches JSON, publishedWorks JSON, presentedPapers JSON, awards JSON,
  innovationProjects JSON, citations INT DEFAULT 0, orcid VARCHAR(80),
  googleScholar VARCHAR(255), researchGate VARCHAR(255), researchTitle VARCHAR(255),
  adviser VARCHAR(160), yearCompleted VARCHAR(40), researchOutputStatus VARCHAR(60),
  createdAt DATETIME, updatedAt DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Events module table
CREATE TABLE IF NOT EXISTS events_module (
  id VARCHAR(36) PRIMARY KEY, title VARCHAR(255), theme VARCHAR(255),
  dateTime VARCHAR(40), venue VARCHAR(255), description TEXT, registrationLink VARCHAR(255),
  programFlow TEXT, speakers TEXT, photo VARCHAR(500) DEFAULT '', gallery JSON, createdAt DATETIME, updatedAt DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Event registrations table
CREATE TABLE IF NOT EXISTS event_registrations (
  id VARCHAR(36) PRIMARY KEY, eventId VARCHAR(36), userId VARCHAR(36),
  participantName VARCHAR(160), institution VARCHAR(160), email VARCHAR(160),
  participantType VARCHAR(40), role VARCHAR(40) DEFAULT 'attendee',
  abstractFile VARCHAR(255) DEFAULT NULL, attendanceStatus VARCHAR(40) DEFAULT 'absent',
  certificateIssued TINYINT(1) DEFAULT 0, certificateData JSON, createdAt DATETIME,
  KEY `idx_reg_event` (`eventId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Event abstracts table
CREATE TABLE IF NOT EXISTS event_abstracts (
  id VARCHAR(36) PRIMARY KEY, eventId VARCHAR(36), userId VARCHAR(36),
  title VARCHAR(255), authors VARCHAR(255), abstract TEXT, keywords VARCHAR(255),
  strand VARCHAR(120), status VARCHAR(40) DEFAULT 'submitted', createdAt DATETIME,
  KEY `idx_abs_event` (`eventId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Innovation & Extension table
CREATE TABLE IF NOT EXISTS innovation_extension (
  id VARCHAR(36) PRIMARY KEY, projectType VARCHAR(60), title VARCHAR(255),
  proponents VARCHAR(255), department VARCHAR(160), description TEXT,
  beneficiaries INT DEFAULT 0, implementationDate VARCHAR(60), outputProduct TEXT,
  communityPartner VARCHAR(255), needsAssessment TEXT, interventionConducted TEXT,
  evaluationResult TEXT, communityOutcome TEXT, sustainabilityPlan TEXT,
  supportingDocuments JSON, impactDocuments JSON, createdAt DATETIME, updatedAt DATETIME,
  KEY `idx_inno_type` (`projectType`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inquiries table
CREATE TABLE IF NOT EXISTS inquiries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160), email VARCHAR(160), subject VARCHAR(255),
  message TEXT, receivedAt DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System logs table
CREATE TABLE IF NOT EXISTS system_logs (
  id VARCHAR(36) PRIMARY KEY, action VARCHAR(80), details TEXT,
  userId VARCHAR(36) DEFAULT NULL, ip VARCHAR(64) DEFAULT NULL,
  userAgent TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- In-app notifications (bell) — mirrors user-scoped events from system_logs
CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(36) PRIMARY KEY, userId VARCHAR(36) DEFAULT NULL,
  action VARCHAR(80), title VARCHAR(255), message TEXT, link VARCHAR(255),
  readAt DATETIME DEFAULT NULL, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_notif_user` (`userId`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Direct messages between registered users
CREATE TABLE IF NOT EXISTS direct_messages (
  id VARCHAR(36) PRIMARY KEY,
  senderId VARCHAR(36) DEFAULT NULL,
  recipientId VARCHAR(36) DEFAULT NULL,
  body TEXT,
  readAt DATETIME DEFAULT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_dm_sender` (`senderId`, `createdAt`),
  KEY `idx_dm_recipient` (`recipientId`, `createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
