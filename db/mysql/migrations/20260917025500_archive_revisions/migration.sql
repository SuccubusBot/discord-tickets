-- Retain message revisions without the 64 KiB TEXT limit.
ALTER TABLE `archivedMessages` MODIFY `content` LONGTEXT NOT NULL;
