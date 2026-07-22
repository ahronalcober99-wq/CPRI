CREATE DATABASE IF NOT EXISTS cpri CHARACTER SET utf8mb4;
USE cpri;

CREATE TABLE users (
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
  resetToken VARCHAR(120) DEFAULT NULL,
  resetTokenExpiry BIGINT DEFAULT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submissions (
  id VARCHAR(36) PRIMARY KEY,
  submitterId VARCHAR(36),
  submitterName VARCHAR(160),
  title VARCHAR(255), authors VARCHAR(255), program VARCHAR(160), adviser VARCHAR(160),
  category VARCHAR(120), researchType VARCHAR(120), abstract TEXT,
  keywords VARCHAR(255), schoolYear VARCHAR(40), semester VARCHAR(40),
  status VARCHAR(40) DEFAULT 'submitted',
  statusHistory JSON, files JSON, additionalDocs JSON, versions JSON, comments JSON,
  createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE repository (
  id VARCHAR(36) PRIMARY KEY,
  sourceSubmissionId VARCHAR(36) DEFAULT NULL,
  title VARCHAR(255), authors VARCHAR(255), adviser VARCHAR(160),
  department VARCHAR(160), abstract TEXT, keywords VARCHAR(255),
  category VARCHAR(120), yearCompleted VARCHAR(40), status VARCHAR(40),
  fileAvailable TINYINT(1) DEFAULT 0, accessLevel VARCHAR(40),
  citation JSON, createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE publications (
  id VARCHAR(36) PRIMARY KEY, title VARCHAR(255), authors VARCHAR(255),
  journalOrConference VARCHAR(255), publicationDate VARCHAR(40),
  volume VARCHAR(40), issue VARCHAR(40), pages VARCHAR(40), doi VARCHAR(160),
  publicationLink VARCHAR(255), indexingStatus VARCHAR(120), pubType VARCHAR(60),
  status VARCHAR(40), authorType VARCHAR(40), department VARCHAR(160),
  schoolYear VARCHAR(40), proofDocuments JSON, submitterId VARCHAR(36),
  submitterName VARCHAR(160), createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE ethics (
  id VARCHAR(36) PRIMARY KEY, submitterId VARCHAR(36), submitterName VARCHAR(160),
  title VARCHAR(255), researchers VARCHAR(255), adviser VARCHAR(160), department VARCHAR(160),
  participantType VARCHAR(60), riskLevel VARCHAR(60), status VARCHAR(60) DEFAULT 'submitted',
  statusHistory JSON, files JSON, additionalDocs JSON, comments JSON,
  certificate JSON, compliance JSON, revisedDocuments JSON,
  createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE researchers (
  id VARCHAR(36) PRIMARY KEY, type VARCHAR(40), fullName VARCHAR(160),
  department VARCHAR(160), program VARCHAR(160), researchInterests TEXT,
  completedResearches JSON, publishedWorks JSON, presentedPapers JSON, awards JSON,
  innovationProjects JSON, citations INT DEFAULT 0, orcid VARCHAR(80),
  googleScholar VARCHAR(255), researchGate VARCHAR(255), researchTitle VARCHAR(255),
  adviser VARCHAR(160), yearCompleted VARCHAR(40), researchOutputStatus VARCHAR(60),
  createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE events_module (
  id VARCHAR(36) PRIMARY KEY, title VARCHAR(255), theme VARCHAR(255),
  dateTime VARCHAR(40), venue VARCHAR(255), description TEXT, registrationLink VARCHAR(255),
  programFlow TEXT, speakers TEXT, gallery JSON, createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE event_registrations (
  id VARCHAR(36) PRIMARY KEY, eventId VARCHAR(36), userId VARCHAR(36),
  participantName VARCHAR(160), institution VARCHAR(160), email VARCHAR(160),
  participantType VARCHAR(40), role VARCHAR(40) DEFAULT 'attendee',
  abstractFile VARCHAR(255) DEFAULT NULL, attendanceStatus VARCHAR(40) DEFAULT 'absent',
  certificateIssued TINYINT(1) DEFAULT 0, certificateData JSON, createdAt DATETIME
);

CREATE TABLE event_abstracts (
  id VARCHAR(36) PRIMARY KEY, eventId VARCHAR(36), userId VARCHAR(36),
  title VARCHAR(255), authors VARCHAR(255), abstract TEXT, keywords VARCHAR(255),
  strand VARCHAR(120), status VARCHAR(40) DEFAULT 'submitted', createdAt DATETIME
);

CREATE TABLE innovation_extension (
  id VARCHAR(36) PRIMARY KEY, projectType VARCHAR(60), title VARCHAR(255),
  proponents VARCHAR(255), department VARCHAR(160), description TEXT,
  beneficiaries INT DEFAULT 0, implementationDate VARCHAR(40), outputProduct TEXT,
  communityPartner VARCHAR(255), needsAssessment TEXT, interventionConducted TEXT,
  evaluationResult TEXT, communityOutcome TEXT, sustainabilityPlan TEXT,
  supportingDocuments JSON, impactDocuments JSON, createdAt DATETIME, updatedAt DATETIME
);

CREATE TABLE inquiries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160), email VARCHAR(160), subject VARCHAR(255),
  message TEXT, receivedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_logs (
  id VARCHAR(36) PRIMARY KEY, action VARCHAR(80), details TEXT,
  userId VARCHAR(36) DEFAULT NULL, ip VARCHAR(64) DEFAULT NULL,
  userAgent TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_submissions_submitter ON submissions(submitterId);
CREATE INDEX idx_repo_source ON repository(sourceSubmissionId);
CREATE INDEX idx_pubs_submitter ON publications(submitterId);
CREATE INDEX idx_eth_submitter ON ethics(submitterId);
CREATE INDEX idx_reg_event ON event_registrations(eventId);
CREATE INDEX idx_abs_event ON event_abstracts(eventId);
CREATE INDEX idx_inno_type ON innovation_extension(projectType);