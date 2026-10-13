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

-- cat_id lives in its own id space, unrelated to page_id and to lt_id, and
-- nothing points at it from categorylinks. It is the source of the category
-- NAMES (underscored, like page titles do not carry) and of the authoritative
-- cat_pages/cat_subcats counts.
CREATE TABLE `category` (
  `cat_id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `cat_title` varbinary(255) NOT NULL DEFAULT '',
  `cat_pages` int(11) NOT NULL DEFAULT '0',
  `cat_subcats` int(11) NOT NULL DEFAULT '0',
  `cat_files` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`cat_id`),
  UNIQUE KEY `cat_title` (`cat_title`),
  KEY `cat_pages` (`cat_pages`)
) ENGINE=InnoDB AUTO_INCREMENT=250564340 DEFAULT CHARSET=binary;

-- cl_from  = the page that carries the link
-- cl_type  = what that page is ('subcat' links categories to their parent)
-- cl_target_id = linktarget.lt_id of the category being linked to. There is no
--                title column here: the name lives in linktarget, and the count
--                lives in category. Note the id spaces below are all disjoint.
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

-- The table categorylinks.cl_target_id actually points at. lt_id is its own
-- id space: it collides with no page_id and no cat_id, which is exactly why
-- guessing the wrong join silently drops almost every row. Only namespace 14
-- (category pages) is of interest; -2, -1, 0 and 6 are media, special and
-- article targets that ingest must ignore even when the title looks like a
-- category.
CREATE TABLE `linktarget` (
  `lt_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `lt_namespace` int(11) NOT NULL,
  `lt_title` varbinary(255) NOT NULL,
  PRIMARY KEY (`lt_id`),
  UNIQUE KEY `lt_namespace_title` (`lt_namespace`,`lt_title`)
) ENGINE=InnoDB AUTO_INCREMENT=20184610 DEFAULT CHARSET=binary;

-- Namespaces 3, 4, 5 and 7 carry the Category: prefix; the namespace is 14 and
-- the title is stored without it. Page 7 must be dropped by the meta filter.
INSERT INTO `page` VALUES
(1,0,'Physics',0,0,0.856935107283,'20260731120255',NULL,1367012995,111,'wikitext',NULL),
(2,0,'Entropy',0,0,0.870480291199,'20260805045949',NULL,1367786022,113994,'wikitext',NULL),
(3,14,'Physical sciences',0,0,0.13895768761,'20260718034000',NULL,783865149,90,'wikitext',NULL),
(4,14,'Thermodynamics',0,0,0.14295768122,'20260718034000',NULL,783865170,92,'wikitext',NULL),
(5,14,'Information theory',0,0,0.42614218343,'20260718034000',NULL,783865221,95,'wikitext',NULL),
(6,0,'CS1 references',0,0,0.33088243432,'20260718034000',NULL,783865281,90,'wikitext',NULL),
(7,14,'CS1 references categories',0,0,0.29470028311,'20260718034000',NULL,783865299,64,'wikitext',NULL),
(8,0,'Quantum mechanics',0,0,0.51188344219,'20260718034000',NULL,783865302,98,'wikitext',NULL),
(9,0,'Black hole',0,0,0.61728400922,'20260718034000',NULL,783865310,101,'wikitext',NULL);

-- cat_pages is deliberately NOT the number of categorylinks rows pointing here
-- (9/7/5 against member counts of 3/4/3, and cat_pages also counts subcategory
-- pages and links lost to the meta filter): Task 6 must read the authoritative
-- count rather than counting member rows.
INSERT INTO `category` VALUES
(70122884,'Physical_sciences',9,2,0),
(70122885,'Thermodynamics',7,1,1),
(70122886,'Information_theory',5,0,0),
(70122887,'CS1_references_categories',1,1,0);

-- Dump order is arbitrary, exactly as it is in the real dump. lt_ids 20184602
-- and 20184603 are the decoys: ns 0 and ns 6, i.e. not categories. 20184602
-- carries the title 'Physical_sciences' on purpose, so dropping the namespace
-- filter would forge a second, bogus mapping onto a real category.
INSERT INTO `linktarget` VALUES
(60335879,-2,'Example.jpg'),
(20184602,0,'Physical_sciences'),
(20184598,14,'Physical_sciences'),
(20184599,14,'Thermodynamics'),
(20184600,14,'Information_theory'),
(20184601,14,'CS1_references_categories'),
(20184603,6,'Entropy_diagram.svg');

-- Every cl_target_id below is an lt_id, never a cat_id.
-- Page 3 listing itself under its own category is not possible on Wikipedia
-- but costs nothing to model here: ingest drops self edges.
-- Two rows are expected to fail to resolve: 20184601 names a category the meta
-- filter dropped, and 20184602 is not a category at all. They are kept, rather
-- than deleted, so the fixture exercises the unresolvable path; enough
-- resolving rows are left that the resolution guard still clears its floor.
INSERT INTO `categorylinks` VALUES
(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,20184598),
(4,'THERMODYNAMICS','2026-07-07 10:01:29','','subcat',1,20184598),
(5,'INFORMATIONTHEORY','2026-07-07 10:01:29','','subcat',1,20184598),
(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184599),
(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184600),
(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184598),
(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184598),
(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184599),
(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184600),
(8,'QUANTUMMECHANICS','2026-07-07 10:01:29','','page',1,20184599),
(8,'QUANTUMMECHANICS','2026-07-07 10:01:29','','page',1,20184600),
(9,'BLACKHOLE','2026-07-07 10:01:29','','page',1,20184598),
(9,'BLACKHOLE','2026-07-07 10:01:29','','page',1,20184599),
(6,'CS1REFERENCES','2026-07-07 10:01:29','','page',1,20184601);