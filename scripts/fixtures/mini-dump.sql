-- Minimal enwiki-shaped dump fragment for pipeline tests.
-- Column order is copied verbatim from the real dumps' CREATE TABLE
-- statements (2026-08 snapshot), because the parser resolves fields by name.
-- Table order mirrors the real dump: page before categorylinks.

CREATE TABLE `page` (
  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,
  `page_namespace` int(11) NOT NULL DEFAULT 0,
  `page_title` varbinary(255) NOT NULL DEFAULT '',
  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT 0,
  `page_is_new` tinyint(1) unsigned NOT NULL DEFAULT 0,
  `page_random` double unsigned NOT NULL DEFAULT 0,
  `page_touched` binary(14) NOT NULL,
  `page_links_updated` binary(14) DEFAULT NULL,
  `page_latest` int(8) unsigned NOT NULL DEFAULT 0,
  `page_len` int(8) unsigned NOT NULL DEFAULT 0,
  `page_content_model` varbinary(32) DEFAULT NULL,
  `page_lang` varbinary(35) DEFAULT NULL,
  PRIMARY KEY (`page_id`),
  UNIQUE KEY `page_name_title` (`page_namespace`,`page_title`)
) ENGINE=InnoDB DEFAULT CHARSET=binary;

-- cat_id lives in its own id space, unrelated to page_id and much larger:
-- categorylinks.cl_target_id points here, NOT at page.page_id.
CREATE TABLE `category` (
  `cat_id` int(8) unsigned NOT NULL AUTO_INCREMENT,
  `cat_title` varbinary(255) NOT NULL DEFAULT '',
  `cat_pages` int(8) unsigned NOT NULL DEFAULT '0',
  `cat_subcats` int(8) unsigned NOT NULL DEFAULT '0',
  `cat_hidden` tinyint(1) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`cat_id`,`cat_title`)
) ENGINE=InnoDB DEFAULT CHARSET=binary;

-- cl_from  = the page that carries the link
-- cl_type  = what that page is ('subcat' links categories to their parent)
-- cl_target_id = cat_id of the category being linked to; the category's
--                name lives in `category`, never in this table
CREATE TABLE `categorylinks` (
  `cl_from` int(8) unsigned NOT NULL DEFAULT 0,
  `cl_sortkey` varbinary(230) NOT NULL DEFAULT '',
  `cl_timestamp` timestamp NOT NULL DEFAULT '0000-00-00 00:00:00',
  `cl_sortkey_prefix` varbinary(255) NOT NULL DEFAULT '',
  `cl_type` enum('page','subcat','file') NOT NULL DEFAULT 'page',
  `cl_collation_id` smallint(5) unsigned NOT NULL DEFAULT 0,
  `cl_target_id` bigint(20) unsigned NOT NULL,
  PRIMARY KEY (`cl_from`,`cl_target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=binary;

-- Namespaces 3, 4, 5 and 7 carry the Category: prefix; the namespace is 14 and
-- the title is stored without it. Page 7 must be dropped by the meta filter.
INSERT INTO `page` VALUES
(1,0,'Physics',0,0,0.856935107283,'20260731120255',NULL,1367012995,111,'wikitext',NULL),
(2,0,'Entropy',0,0,0.870480291199,'20260805045949',NULL,1367786022,113994,'wikitext',NULL),
(3,14,'Physical sciences',0,0,0.13895768761,'20260718034000',NULL,783865149,90,'wikitext',NULL),
(4,14,'Thermodynamics',0,0,0.14295768122,'20260718034000',NULL,783865170,92,'wikitext',NULL),
(5,14,'Information theory',0,0,0.42614218343,'20260718034000',NULL,783865221,95,'wikitext',NULL),
(6,0,'CS1 references',0,0,0.33088243432,'20260718034000',NULL,783865281,90,'wikitext',NULL),
(7,14,'CS1 references categories',0,0,0.29470028311,'20260718034000',NULL,783865299,64,'wikitext',NULL);

-- Page 3 listing itself under its own category is not possible on Wikipedia
-- but costs nothing to model here: ingest drops self edges.
INSERT INTO `category` VALUES
(24745139,'Achilles',10,1,0),
(27206937,'Anarchism',30,2,0),
(51529579,'Autism spectrum',20,1,0),
(70122884,'Physical sciences',5,2,0),
(70122885,'Thermodynamics',4,1,0),
(70122886,'Information theory',3,1,0),
(70122887,'CS1 references categories',1,1,0);

INSERT INTO `categorylinks` VALUES
(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,70122884),
(4,'THERMODYNAMICS','2026-07-07 10:01:29','','subcat',1,70122884),
(5,'INFORMATIONTHEORY','2026-07-07 10:01:29','','subcat',1,70122884),
(2,'ENTROPY','2026-07-07 10:01:29','','page',1,70122885),
(2,'ENTROPY','2026-03-11 08:12:00','','page',1,70122886),
(1,'PHYSICS','2026-07-07 10:01:29','','page',1,70122884),
(6,'CS1REFERENCES','2026-07-07 10:01:29','','page',1,70122887),
(6,'CS1REFERENCES','2026-07-07 10:01:29','','page',1,70122884);