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
  -- Editable profile fields added by the profile page (all nullable; existing
  -- rows just get the defaults). Student Researcher fields are only relevant
  -- for that role; the API ignores them for everyone else.
  studentId VARCHAR(60) DEFAULT '',
  yearLevel VARCHAR(30) DEFAULT '',
  program VARCHAR(180) DEFAULT '',
  section VARCHAR(60) DEFAULT '',
  adviser VARCHAR(160) DEFAULT '',
  researchTitle VARCHAR(255) DEFAULT '',
  researchArea VARCHAR(80) DEFAULT '',
  researches JSON,
  -- Migration 2026-10-11: profile edit (schema 2026-10-11): department,
  -- contactNo, researchInterests, studentId, yearLevel, program, section,
  -- adviser, researchTitle, researchArea
  contactNo VARCHAR(60) NOT NULL DEFAULT '',
  user_prefs JSON,
  setupPending TINYINT(1) DEFAULT 0,
  -- SMS-verified contact number (server/phone-verification.js). The number
  -- itself lives in contactNumber once verified; these columns flag the state.
  phone_verified TINYINT(1) NOT NULL DEFAULT 0,
  phone_verified_at DATETIME DEFAULT NULL,
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
