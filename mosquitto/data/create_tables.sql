DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `acls`;

CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(25) NOT NULL,
  `pw` varchar(256) NOT NULL,
  `super` int(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=1013 DEFAULT CHARSET=utf16 ROW_FORMAT=DYNAMIC;

CREATE TABLE `acls` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(25) NOT NULL,
  `topic` varchar(256) NOT NULL,
  `rw` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `acls_user_topic` (`username`,`topic`(228))
) ENGINE=InnoDB AUTO_INCREMENT=1013 DEFAULT CHARSET=utf16 ROW_FORMAT=DYNAMIC;

LOCK TABLES `users` WRITE;
INSERT INTO `users` VALUES
	(1,'admin','%%ADMIN_PASSWORD%%',1),
	(2,'homeassistant','%%HASS_PASSWORD%%',0),
	(3,'addons','%%ADDONS_PASSWORD%%',0);
UNLOCK TABLES;

LOCK TABLES `acls` WRITE;
INSERT INTO `acls` VALUES
	(1,'admin','#',7),
	(2,'homeassistant','#',7),
	(3, 'addons','#',7);
UNLOCK TABLES;
