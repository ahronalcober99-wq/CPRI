-- MariaDB dump 10.19  Distrib 10.4.32-MariaDB, for Win64 (AMD64)
--
-- Host: localhost    Database: cpri
-- ------------------------------------------------------
-- Server version	10.4.32-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `direct_messages`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `direct_messages` (
  `id` varchar(36) NOT NULL,
  `senderId` varchar(36) DEFAULT NULL,
  `recipientId` varchar(36) DEFAULT NULL,
  `body` text DEFAULT NULL,
  `readAt` datetime DEFAULT NULL,
  `createdAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_dm_sender` (`senderId`,`createdAt`),
  KEY `idx_dm_recipient` (`recipientId`,`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ethics`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ethics` (
  `id` varchar(36) NOT NULL,
  `submitterId` varchar(36) DEFAULT NULL,
  `submitterName` varchar(160) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `researchers` varchar(255) DEFAULT NULL,
  `adviser` varchar(160) DEFAULT NULL,
  `department` varchar(160) DEFAULT NULL,
  `participantType` varchar(60) DEFAULT NULL,
  `riskLevel` varchar(60) DEFAULT NULL,
  `status` varchar(60) DEFAULT 'submitted',
  `statusHistory` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`statusHistory`)),
  `files` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`files`)),
  `additionalDocs` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`additionalDocs`)),
  `comments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`comments`)),
  `certificate` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`certificate`)),
  `compliance` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`compliance`)),
  `revisedDocuments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`revisedDocuments`)),
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_eth_submitter` (`submitterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `event_abstracts`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `event_abstracts` (
  `id` varchar(36) NOT NULL,
  `eventId` varchar(36) DEFAULT NULL,
  `userId` varchar(36) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `authors` varchar(255) DEFAULT NULL,
  `abstract` text DEFAULT NULL,
  `keywords` varchar(255) DEFAULT NULL,
  `strand` varchar(120) DEFAULT NULL,
  `status` varchar(40) DEFAULT 'submitted',
  `createdAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_abs_event` (`eventId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `event_registrations`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `event_registrations` (
  `id` varchar(36) NOT NULL,
  `eventId` varchar(36) DEFAULT NULL,
  `userId` varchar(36) DEFAULT NULL,
  `participantName` varchar(160) DEFAULT NULL,
  `institution` varchar(160) DEFAULT NULL,
  `email` varchar(160) DEFAULT NULL,
  `participantType` varchar(40) DEFAULT NULL,
  `role` varchar(40) DEFAULT 'attendee',
  `abstractFile` varchar(255) DEFAULT NULL,
  `attendanceStatus` varchar(40) DEFAULT 'absent',
  `certificateIssued` tinyint(1) DEFAULT 0,
  `certificateData` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`certificateData`)),
  `createdAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_reg_event` (`eventId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `events_module`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `events_module` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `theme` varchar(255) DEFAULT NULL,
  `dateTime` varchar(40) DEFAULT NULL,
  `venue` varchar(255) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `registrationLink` varchar(255) DEFAULT NULL,
  `programFlow` text DEFAULT NULL,
  `speakers` text DEFAULT NULL,
  `gallery` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`gallery`)),
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  `photo` varchar(500) DEFAULT '',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `innovation_extension`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `innovation_extension` (
  `id` varchar(36) NOT NULL,
  `projectType` varchar(60) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `proponents` varchar(255) DEFAULT NULL,
  `department` varchar(160) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `beneficiaries` int(11) DEFAULT 0,
  `implementationDate` varchar(40) DEFAULT NULL,
  `outputProduct` text DEFAULT NULL,
  `communityPartner` varchar(255) DEFAULT NULL,
  `needsAssessment` text DEFAULT NULL,
  `interventionConducted` text DEFAULT NULL,
  `evaluationResult` text DEFAULT NULL,
  `communityOutcome` text DEFAULT NULL,
  `sustainabilityPlan` text DEFAULT NULL,
  `supportingDocuments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`supportingDocuments`)),
  `impactDocuments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`impactDocuments`)),
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_inno_type` (`projectType`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `inquiries`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `inquiries` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` varchar(160) DEFAULT NULL,
  `email` varchar(160) DEFAULT NULL,
  `subject` varchar(255) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `receivedAt` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=19 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `notifications`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `notifications` (
  `id` varchar(36) NOT NULL,
  `userId` varchar(36) DEFAULT NULL,
  `action` varchar(80) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `link` varchar(255) DEFAULT NULL,
  `readAt` datetime DEFAULT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`userId`,`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `publications`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `publications` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `authors` varchar(255) DEFAULT NULL,
  `journalOrConference` varchar(255) DEFAULT NULL,
  `publicationDate` varchar(40) DEFAULT NULL,
  `volume` varchar(40) DEFAULT NULL,
  `issue` varchar(40) DEFAULT NULL,
  `pages` varchar(40) DEFAULT NULL,
  `doi` varchar(160) DEFAULT NULL,
  `publicationLink` varchar(255) DEFAULT NULL,
  `indexingStatus` varchar(120) DEFAULT NULL,
  `pubType` varchar(60) DEFAULT NULL,
  `status` varchar(40) DEFAULT NULL,
  `authorType` varchar(40) DEFAULT NULL,
  `department` varchar(160) DEFAULT NULL,
  `schoolYear` varchar(40) DEFAULT NULL,
  `proofDocuments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`proofDocuments`)),
  `submitterId` varchar(36) DEFAULT NULL,
  `submitterName` varchar(160) DEFAULT NULL,
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  `sourceSubmissionId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pubs_submitter` (`submitterId`),
  KEY `idx_pubs_source` (`sourceSubmissionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `repository`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `repository` (
  `id` varchar(36) NOT NULL,
  `sourceSubmissionId` varchar(36) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `authors` varchar(255) DEFAULT NULL,
  `adviser` varchar(160) DEFAULT NULL,
  `department` varchar(160) DEFAULT NULL,
  `abstract` text DEFAULT NULL,
  `keywords` varchar(255) DEFAULT NULL,
  `category` varchar(120) DEFAULT NULL,
  `yearCompleted` varchar(40) DEFAULT NULL,
  `status` varchar(40) DEFAULT NULL,
  `fileAvailable` tinyint(1) DEFAULT 0,
  `accessLevel` varchar(40) DEFAULT NULL,
  `citation` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`citation`)),
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_repo_source` (`sourceSubmissionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `researchers`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `researchers` (
  `id` varchar(36) NOT NULL,
  `type` varchar(40) DEFAULT NULL,
  `fullName` varchar(160) DEFAULT NULL,
  `department` varchar(160) DEFAULT NULL,
  `program` varchar(160) DEFAULT NULL,
  `researchInterests` text DEFAULT NULL,
  `completedResearches` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`completedResearches`)),
  `publishedWorks` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`publishedWorks`)),
  `presentedPapers` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`presentedPapers`)),
  `awards` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`awards`)),
  `innovationProjects` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`innovationProjects`)),
  `citations` int(11) DEFAULT 0,
  `orcid` varchar(80) DEFAULT NULL,
  `googleScholar` varchar(255) DEFAULT NULL,
  `researchGate` varchar(255) DEFAULT NULL,
  `researchTitle` varchar(255) DEFAULT NULL,
  `adviser` varchar(160) DEFAULT NULL,
  `yearCompleted` varchar(40) DEFAULT NULL,
  `researchOutputStatus` varchar(60) DEFAULT NULL,
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `submissions`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `submissions` (
  `id` varchar(36) NOT NULL,
  `submitterId` varchar(36) DEFAULT NULL,
  `submitterName` varchar(160) DEFAULT NULL,
  `title` varchar(255) DEFAULT NULL,
  `authors` varchar(255) DEFAULT NULL,
  `program` varchar(160) DEFAULT NULL,
  `adviser` varchar(160) DEFAULT NULL,
  `category` varchar(120) DEFAULT NULL,
  `researchType` varchar(120) DEFAULT NULL,
  `abstract` text DEFAULT NULL,
  `keywords` varchar(255) DEFAULT NULL,
  `schoolYear` varchar(40) DEFAULT NULL,
  `semester` varchar(40) DEFAULT NULL,
  `status` varchar(40) DEFAULT 'submitted',
  `statusHistory` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`statusHistory`)),
  `files` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`files`)),
  `additionalDocs` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`additionalDocs`)),
  `versions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`versions`)),
  `comments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`comments`)),
  `createdAt` datetime DEFAULT NULL,
  `updatedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_submissions_submitter` (`submitterId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `system_logs`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_logs` (
  `id` varchar(36) NOT NULL,
  `action` varchar(80) DEFAULT NULL,
  `details` text DEFAULT NULL,
  `userId` varchar(36) DEFAULT NULL,
  `ip` varchar(64) DEFAULT NULL,
  `userAgent` text DEFAULT NULL,
  `timestamp` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `users` (
  `id` varchar(36) NOT NULL,
  `username` varchar(80) NOT NULL,
  `email` varchar(160) NOT NULL,
  `fullName` varchar(160) DEFAULT '',
  `role` varchar(30) NOT NULL,
  `passwordHash` varchar(120) NOT NULL,
  `status` varchar(20) DEFAULT 'active',
  `department` varchar(120) DEFAULT '',
  `contactNumber` varchar(60) DEFAULT '',
  `researchInterests` text DEFAULT NULL,
  `profilePhoto` varchar(255) DEFAULT NULL,
  `researches` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`researches`)),
  `resetToken` varchar(120) DEFAULT NULL,
  `resetTokenExpiry` bigint(20) DEFAULT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  `user_prefs` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`user_prefs`)),
  `setupPending` tinyint(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-10-01  1:02:36
